#!/usr/bin/env python3
"""
render_hyperframes.py — Cloud-only SHG HyperFrames video renderer.

Pipeline:
  1. Load script.json (voiceover + captions + scenes).
  2. Synthesize voice via ElevenLabs `/with-timestamps` (returns mp3 + char alignment).
  3. Group chars -> word-level timestamps using whitespace boundaries.
  4. Derive 12 scene cuts from word timings (~2s windows tied to sentence boundaries).
  5. Build 12 caption blocks (word groups) with per-word reveal times.
  6. Fetch one Pexels portrait per scene using the existing TOPIC_QUERIES map.
  7. Generate ambient music (110/220/330 Hz sine triad, matches FFmpeg renderer).
  8. Render shg_locked_index.html.template with all timings baked in.
  9. Spawn `npx hyperframes@0.5.4 render` -> headless Chromium -> 1080x1920 mp4.
 10. Upload final MP4 to R2 with wrangler.

Output: 1080x1920 MP4 with brand header, footer, progress bar, 12 scene cuts,
        word-level karaoke captions. End to end in a single GHA runner.
"""
import os, sys, json
from pathlib import Path as _P
SCRIPT_DIR = _P(__file__).parent, hashlib, urllib.request, urllib.error, urllib.parse, subprocess, base64, time, re, html
from pathlib import Path

ROOT = Path(__file__).parent
WORK = Path(os.environ.get("WORKDIR", "/tmp/shg_render"))
WORK.mkdir(parents=True, exist_ok=True)

# Brand voice settings (locked in the_side_hustle_guild.yaml)
VOICE_ID  = "kdmDKE6EkgrWrrykO9Qt"   # Alexandra - warm friendly female
MODEL_ID  = "eleven_turbo_v2_5"
VOICE_SETTINGS = {"stability":0.50,"similarity_boost":0.75,"style":0.30,"use_speaker_boost":True}
WIDTH, HEIGHT = 1080, 1920
TARGET_SCENES = 12

# SHG palette
INK       = "#1E1E1E"
SLATE     = "#27384A"
CREAM     = "#F8F4ED"
SUNRISE   = "#E89B3B"
SAGE      = "#A8C9A0"

# Accent / positive emphasis keyword lists — used to colorize words in captions.
ACCENT_WORDS = {
    "ONE","TWO","THREE","SUBMIT","TODAY","NOW","FREE","REAL","WIN","WINS",
    "BUILDERS","HUSTLE","HUSTLES","GUILD","SIDE","FIRST","FOUNDER","FOUNDING",
    "CONTEST","PRIZE","POOL","DOLLAR","DOLLARS","MONEY","CASH","PAID",
    "CLICK","COPY","LINK","PHOTO","STEP","STEPS","FIELDS","MINUTES","DAY",
    "EVERY","WHEN","HOW","WHY",
}
POSITIVE_WORDS = {
    "WELCOME","WIN","WINS","WINNER","WINNERS","CELEBRATE","SUCCESS",
    "DONE","YES","START","BEGIN","BUILD","BUILT","SHIP","SHIPPED",
    "GROW","GROWTH","UP","RISING","STRONG",
}

# ------------------------------------------------------------------ helpers
def env(k, required=True):
    v = os.environ.get(k)
    if required and not v: raise RuntimeError(f"Missing env: {k}")
    return v

def http_get(url, headers=None, timeout=30):
    h = {"User-Agent": "SHG-RenderFarm/2.0 (+https://thesidehustleguild.com)"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def http_post_json(url, headers, body, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
        headers={**headers, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

# ------------------------------------------------------------------ ElevenLabs (with timestamps)
def synth_voice_with_alignment(text, out_mp3, out_alignment_json):
    """Synthesize voice with char-level timestamps. Returns (mp3 path, char alignment dict)."""
    api_key = env("ELEVENLABS_API_KEY")
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/with-timestamps"
    body = {"text": text, "model_id": MODEL_ID, "voice_settings": VOICE_SETTINGS}
    raw = http_post_json(url, {"xi-api-key": api_key, "Accept": "application/json"}, body, timeout=180)
    data = json.loads(raw)
    audio_b64 = data["audio_base64"]
    out_mp3.write_bytes(base64.b64decode(audio_b64))
    alignment = data.get("normalized_alignment") or data["alignment"]
    out_alignment_json.write_text(json.dumps(alignment, indent=2))
    return out_mp3, alignment

def voice_duration_sec(mp3):
    out = subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration",
                                   "-of","default=noprint_wrappers=1:nokey=1", str(mp3)]).decode().strip()
    return float(out)

# ------------------------------------------------------------------ char -> word grouping
def chars_to_words(alignment):
    """Take ElevenLabs char alignment (parallel arrays) and emit word objects.
    Returns list of {text, start, end} with start/end in seconds (audio time)."""
    chars  = alignment["characters"]
    starts = alignment["character_start_times_seconds"]
    ends   = alignment["character_end_times_seconds"]
    words = []
    cur_text = ""
    cur_start = None
    cur_end = None
    for ch, st, en in zip(chars, starts, ends):
        if ch.isspace():
            if cur_text:
                words.append({"text": cur_text, "start": float(cur_start), "end": float(cur_end)})
                cur_text = ""; cur_start = None; cur_end = None
        else:
            if cur_start is None: cur_start = st
            cur_text += ch
            cur_end = en
    if cur_text:
        words.append({"text": cur_text, "start": float(cur_start), "end": float(cur_end)})
    return words

def split_into_sentences(words):
    """Group word objects into sentence-ish phrases based on punctuation."""
    sentences = []
    cur = []
    for w in words:
        cur.append(w)
        # End sentence on punctuation suffix
        if re.search(r'[.!?—–-]$', w["text"]) and len(cur) >= 2:
            sentences.append(cur); cur = []
    if cur: sentences.append(cur)
    return sentences

# ------------------------------------------------------------------ scene timing
def derive_scene_timings(words, total_duration, count=TARGET_SCENES):
    """Build {count} scene windows aligned to nearest word boundaries.
    Tries to split on sentence boundaries; falls back to even slicing.
    Returns list of {start, duration} dicts of length `count`."""
    if not words:
        # Fallback: even slices
        d = total_duration / count
        return [{"start": round(i*d, 3), "duration": round(d, 3)} for i in range(count)]

    sentences = split_into_sentences(words)
    # Convert sentences to (start, end)
    sent_bounds = [(s[0]["start"], s[-1]["end"]) for s in sentences]
    # If fewer sentences than scenes, subdivide longest sentences
    while len(sent_bounds) < count:
        # Find longest, split in half at midpoint
        longest_i = max(range(len(sent_bounds)), key=lambda i: sent_bounds[i][1] - sent_bounds[i][0])
        s, e = sent_bounds[longest_i]
        mid = (s + e) / 2
        sent_bounds = sent_bounds[:longest_i] + [(s, mid), (mid, e)] + sent_bounds[longest_i+1:]
    # If more sentences than scenes, merge shortest neighbors
    while len(sent_bounds) > count:
        # Find smallest combined neighbor pair
        best_i = 0; best_combined = float("inf")
        for i in range(len(sent_bounds)-1):
            combined = (sent_bounds[i][1] - sent_bounds[i][0]) + (sent_bounds[i+1][1] - sent_bounds[i+1][0])
            if combined < best_combined:
                best_combined = combined; best_i = i
        merged = (sent_bounds[best_i][0], sent_bounds[best_i+1][1])
        sent_bounds = sent_bounds[:best_i] + [merged] + sent_bounds[best_i+2:]

    # Force start of first to 0 and end of last to total_duration (so the whole video is covered)
    sent_bounds[0]  = (0.0, sent_bounds[0][1])
    sent_bounds[-1] = (sent_bounds[-1][0], max(sent_bounds[-1][1], total_duration))
    # Stitch so consecutive scenes don't overlap or gap
    fixed = []
    for i, (s, e) in enumerate(sent_bounds):
        if i > 0:
            s = fixed[-1]["start"] + fixed[-1]["duration"]
        d = max(0.6, e - s)
        fixed.append({"start": round(s, 3), "duration": round(d, 3)})
    # Final tweak: extend the last one to total
    tail_start = fixed[-1]["start"]
    fixed[-1]["duration"] = round(max(0.6, total_duration - tail_start), 3)
    return fixed

# ------------------------------------------------------------------ captions
SENTENCE_END_RE = re.compile(r'[.!?—–-]$')

def build_caption_blocks(words, scene_timings):
    """Group words into caption blocks aligned with each scene.
    Returns list of caption dicts ready for template:
      {n, start, duration, size, html, words: [{t}]}
    Exactly len(scene_timings) blocks."""
    blocks = []
    n_scenes = len(scene_timings)
    for i, sc in enumerate(scene_timings):
        sc_start = sc["start"]
        sc_end   = sc["start"] + sc["duration"]
        # Pick words whose midpoint falls inside this scene
        my_words = [w for w in words if w["start"] >= sc_start - 0.01 and w["start"] < sc_end - 0.05]
        if not my_words and i == n_scenes - 1:
            # Tail: include any leftover words past the last scene cap
            my_words = [w for w in words if w["start"] >= sc_start - 0.01]
        if not my_words:
            # No spoken words in this scene — give it a quiet caption-less block
            blocks.append({
                "n": i + 1,
                "start": round(sc_start, 3),
                "duration": round(sc["duration"], 3),
                "size": "s3",
                "html": "",
                "words": [],
            })
            continue

        # Decide caption font size: hook = first block, then taper
        if i == 0:
            size = "hook"
            max_per_line = 2
        elif i <= 2:
            size = "s1"
            max_per_line = 3
        elif i <= 5:
            size = "s2"
            max_per_line = 4
        else:
            size = "s3"
            max_per_line = 5

        # Cap at 8 words per block for visual rhythm
        my_words = my_words[:8]

        block_start = my_words[0]["start"]
        block_end   = min(my_words[-1]["end"] + 0.2, sc_end)
        if block_end <= block_start + 0.4:
            block_end = block_start + 0.4

        # Build HTML with <span class="w accent|positive"> wrappers + <br> every N words
        spans = []
        for wi, w in enumerate(my_words):
            text = re.sub(r'[.!?,;:—–]+$', '', w["text"])
            up = text.upper()
            cls = "w"
            if up in POSITIVE_WORDS:
                cls = "w positive"
            elif up in ACCENT_WORDS:
                cls = "w accent"
            # Mostly-digit token => accent
            elif re.fullmatch(r'[\d$,.\-]+', up):
                cls = "w accent"
            spans.append((cls, html.escape(up), wi))

        # Layout: insert <br> every max_per_line words
        out_html_parts = []
        for j, (cls, txt, wi) in enumerate(spans):
            if j > 0 and j % max_per_line == 0:
                out_html_parts.append("<br>")
            elif j > 0:
                out_html_parts.append(" ")
            out_html_parts.append(f'<span class="{cls}" id="c{i+1}w{wi+1}">{txt}</span>')
        block_html = "".join(out_html_parts)

        # Per-word reveal times (absolute audio time)
        word_times = [{"t": round(w["start"], 3)} for w in my_words]

        blocks.append({
            "n": i + 1,
            "start": round(block_start, 3),
            "duration": round(block_end - block_start, 3),
            "size": size,
            "html": block_html,
            "words": word_times,
        })
    return blocks

# ------------------------------------------------------------------ Pexels

# Real SHG asset map — local screenshots beat stock photos every time
LOCAL_ASSETS = {
  # Brand / end card / homepage
  "shg_brand_endcard":              "brand_logo_big.jpg",
  "homepage_hero_branded":          "homepage_hero.jpg",
  "shg_homepage_hero":              "homepage_hero.jpg",
  # 100-member moment + counter
  "counter_dial":                   "homepage_counter.jpg",
  "countdown_animation_overlay":    "homepage_100moment.jpg",
  # Prize pool math
  "calculator_math_percent":        "homepage_pool_math.jpg",
  "calculator_compound_growth":     "homepage_pool_math.jpg",
  "money_stack_growing_chart":      "homepage_pool_math.jpg",
  "growth_chart_slate":             "homepage_pool_math.jpg",
  "subscription_revenue_chart":     "homepage_pool_math.jpg",
  # Inside the Guild rooms
  "exchange_forum_view":            "submissions_gallery.jpg",
  "hustle_card_thread":             "submissions_gallery.jpg",
  "community_members_avatars":      "homepage_rooms.jpg",
  "real_builders_community":        "homepage_rooms.jpg",
  # Pricing
  "three_tier_cards":               "homepage_tiers.jpg",
  "founder_offer_card":             "brand_founder_card.jpg",
  "founder_membership_badge":       "brand_founder_card.jpg",
  "founder_card_brand":             "brand_founder_card.jpg",
  "checkout_screen_close":          "homepage_tiers.jpg",
  "nine_dollar_price_tag":          "homepage_tiers.jpg",
  "lifetime_locked_seal":           "homepage_tiers.jpg",
  "subscription_billing_screen":    "homepage_tiers.jpg",
  # Affiliate
  "affiliate_dashboard_growing":    "affiliate_landing.jpg",
  "recurring_growth":               "affiliate_math.jpg",
  "recurring_payment_notification": "affiliate_math.jpg",
  # Sponsors
  "sponsors_page":                  "sponsors_landing.jpg",
  # Submit flow
  "submit_page_screenshot":         "submit_page_steps.jpg",
  "submit_button_click":            "submit_page_button.jpg",
  "phone_submit_form":              "submit_page_steps.jpg",
  "phone_form_scrolling":           "submit_page_steps.jpg",
  "submit_confirmation":            "submit_page_button.jpg",
  "form_fields_filling":            "submit_page_steps.jpg",
  # Discord screens (real channels)
  "discord_screen":                 "discord_general_chat.jpg",
  "discord_community_screen":       "discord_general_chat.jpg",
  "discord_chat_window_close":      "discord_general_chat.jpg",
  "discord_channel_list":           "discord_announcements.jpg",
  "discord_stage_live":             "discord_announcements.jpg",
  "live_stage_discord_audio":       "discord_announcements.jpg",
  "champion_day_live_stage":        "discord_announcements.jpg",
  "winner_announcement_stream":     "discord_wins_of_the_month.jpg",
  "winner_reveal_overlay":          "discord_wins_of_the_month.jpg",
  "judges_scoring_review":          "discord_monthly_theme.jpg",
  # CTA / bio link — homepage hero works
  "phone_bio_link_tap":             "homepage_hero.jpg",
}

TOPIC_QUERIES = {
    "kitchen_table_laptop":     "person laptop kitchen morning",
    "submit_page_screenshot":   "modern web form mobile screen",
    "submit_button_click":      "finger tapping phone screen",
    "countdown_animation_overlay":"large number minimal background",
    "discord_screen":           "online community chat phone",
    "founder_offer_card":       "membership badge minimal",
    "calculator_overlay":       "calculator desk top down",
    "growth_chart_slate":       "ascending chart screen",
    "ladder_graphic":           "stairs minimal abstract",
    "phone_taking_photo":       "smartphone taking picture product",
    "copying_url_browser":      "phone web browser screen",
    "phone_form_scrolling":     "filling out form phone",
    "form_fields_filling":      "typing into form mobile",
    "submit_confirmation":      "green check mark success",
    "hand_typed_zero":          "typing keyboard close up",
    "hustle_card_thread":       "online forum post screen",
    "sunrise_calm":             "sunrise warm window morning",
    "planner_coffee_topdown":   "planner coffee top down",
    "hand_filling_planner":     "hand writing notebook",
    "end_card_brand":           "warm cream texture minimal",
    "checkout_screen_close":    "subscription checkout phone",
    "counter_dial":             "mechanical counter close",
    "founder_card_brand":       "membership card design",
    "recurring_growth":         "compound growth visual",
    "sponsors_page":            "pitch deck slide professional",
    "three_tier_cards":         "pricing tiers comparison",
    "x_red_through_yacht":      "luxury yacht stock photo",
    "x_red_through_dead_screen":"empty office computer",
    "discord_stage_live":       "live podcast audio room",
    "winner_reveal_overlay":    "celebration trophy minimal",
    "money_landing_account":    "phone payment notification",
    "discord_channel_list":     "sidebar menu app interface",
    "exchange_forum_view":      "forum thread laptop",
    "single_dollar_bill":       "single dollar bill desk",
    "hand_writing_principle":   "calligraphy notebook quote",
    "hand_writing_notebook":    "hand journaling close up",
    "shg_homepage_hero":        "modern landing page warm",
    "stack_of_cash_close_up": "stack of cash bills close up money",
    "person_at_laptop_smiling": "smiling person laptop kitchen happy",
    "phone_notification_payment": "smartphone payment received notification",
    "discord_community_screen": "online chat community screen",
    "homepage_hero_branded": "modern landing page hero website",
    "cash_prize_winning_moment": "celebration money winning prize",
    "calendar_calendar_calendar": "calendar wall planner schedule",
    "calculator_math_percent": "calculator desk percentage math",
    "subscription_billing_screen": "subscription billing monthly recurring",
    "phone_bio_link_tap": "smartphone bio link tap finger",
    "shg_brand_endcard": "warm cream texture minimal brand",
    "etsy_shop_owner_packing": "small business packing orders craft",
    "empty_dashboard_no_sales": "empty laptop screen quiet office",
    "cash_dollar_bills_table": "dollar bills spread out table",
    "phone_submit_form": "phone form submission mobile",
    "judges_scoring_review": "review evaluation scorecard rubric",
    "winner_announcement_stream": "live announcement reveal celebration",
    "live_stage_discord_audio": "podcast live audio room stream",
    "calendar_22nd_circled": "calendar date circled marker",
    "money_stack_growing_chart": "money growth chart upward trend",
    "split_screen_two_paths": "fork in road two paths choice",
    "cash_prize_winner_check": "winner big check prize cash",
    "champion_day_live_stage": "stage event audience celebration",
    "affiliate_dashboard_growing": "affiliate dashboard analytics revenue",
    "recurring_payment_notification": "recurring payment notification mobile",
    "calculator_compound_growth": "compound interest math growth",
    "guru_yacht_lifestyle_overlay": "yacht luxury stock cliche",
    "empty_dead_discord_screen": "empty dim computer screen abandoned",
    "rejected_cancelled_red_x": "red x rejection cancelled",
    "person_at_kitchen_table_working": "person working laptop kitchen warm",
    "founder_membership_badge": "membership badge gold premium",
    "nine_dollar_price_tag": "price tag low cost affordable",
    "lifetime_locked_seal": "lifetime guarantee seal stamp",
    "real_builders_community": "diverse builders workshop community",
    "discord_chat_window_close": "chat messaging app close up",
    "cash_money_falling_down": "money falling raining bills",
    "phone_payment_received": "phone payment success notification",
    "calendar_monthly_recurring": "monthly calendar planner",
    "subscription_revenue_chart": "revenue chart growing subscription",
    "community_members_avatars": "diverse profile avatars grid",
    "trophy_award_winner": "trophy gold award winner",
    "loop_repeat_cycle_arrows": "cycle loop arrows infinity",
}

def fetch_pexels_pool(query, n=5, page=1):
    """Return list of (id, url) for up to N photos from Pexels for this query."""
    api_key = env("PEXELS_API_KEY")
    qs = urllib.parse.urlencode({"query": query, "per_page": min(n*2, 15), "orientation": "portrait", "page": page})
    url = f"https://api.pexels.com/v1/search?{qs}"
    try:
        data = json.loads(http_get(url, headers={"Authorization": api_key}))
        photos = data.get("photos", []) or []
        return [(p["id"], p["src"]["large2x"]) for p in photos][:n]
    except Exception as e:
        print(f"  pool fetch fail '{query}' page {page}: {e}", file=sys.stderr)
        return []

def fetch_pexels(query, out_path):
    api_key = env("PEXELS_API_KEY")
    qs = urllib.parse.urlencode({"query": query, "per_page": 5, "orientation": "portrait"})
    url = f"https://api.pexels.com/v1/search?{qs}"
    data = json.loads(http_get(url, headers={"Authorization": api_key}))
    photos = data.get("photos", [])
    if not photos:
        qs2 = urllib.parse.urlencode({"query": query.split()[0], "per_page": 5, "orientation": "portrait"})
        data = json.loads(http_get(f"https://api.pexels.com/v1/search?{qs2}", headers={"Authorization": api_key}))
        photos = data.get("photos", [])
    if not photos:
        raise RuntimeError(f"No Pexels photos for {query}")
    src = photos[0]["src"]["large2x"]
    out_path.write_bytes(http_get(src))
    return out_path

def fallback_cream_image(out_path):
    """Last resort: cream rectangle so the scene isn't broken."""
    subprocess.run(["ffmpeg","-y","-loglevel","error","-f","lavfi",
                    "-i", f"color=c={CREAM}:s={WIDTH}x{HEIGHT}:d=1",
                    "-frames:v","1", str(out_path)], check=True)
    return out_path

# ------------------------------------------------------------------ Music (sine triad)
def generate_music(duration, out_aac):
    music_filter = (
        "[0:a]volume=0.16[a0];"
        "[1:a]volume=0.10[a1];"
        "[2:a]volume=0.06[a2];"
        "[a0][a1][a2]amix=inputs=3:duration=longest[mixed];"
        f"[mixed]highpass=f=80,lowpass=f=2400,volume=0.30,"
        f"afade=t=in:st=0:d=0.8,afade=t=out:st={max(0,duration-1.2)}:d=1.2[out]"
    )
    subprocess.run(["ffmpeg","-y","-loglevel","error",
                    "-f","lavfi","-t",str(duration),"-i","sine=frequency=110:sample_rate=44100",
                    "-f","lavfi","-t",str(duration),"-i","sine=frequency=220:sample_rate=44100",
                    "-f","lavfi","-t",str(duration),"-i","sine=frequency=330:sample_rate=44100",
                    "-filter_complex", music_filter, "-map","[out]",
                    "-c:a","aac","-b:a","128k", str(out_aac)], check=True)
    return out_aac

# ------------------------------------------------------------------ Template render (mini-Jinja)
TEMPLATE_PATH = ROOT / "shg_locked_index.html.template"

def render_template(context):
    """Minimal Jinja-ish renderer. We use real Jinja2 if available, else a tiny fallback.
    This avoids forcing a Jinja install in the GHA runner if pip is slow."""
    try:
        from jinja2 import Environment, FileSystemLoader, select_autoescape
        env = Environment(loader=FileSystemLoader(str(ROOT)), autoescape=False)
        tpl = env.get_template(TEMPLATE_PATH.name)
        return tpl.render(**context)
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "Jinja2"], check=True)
        from jinja2 import Environment, FileSystemLoader
        env = Environment(loader=FileSystemLoader(str(ROOT)), autoescape=False)
        tpl = env.get_template(TEMPLATE_PATH.name)
        return tpl.render(**context)

# ------------------------------------------------------------------ HyperFrames project scaffold
PROJECT_HYPERFRAMES_JSON = {
    "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
    "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
    "paths": {
        "blocks": "compositions",
        "components": "compositions/components",
        "assets": "assets"
    }
}

# ------------------------------------------------------------------ Core render
def render(script, work_dir, out_mp4):
    sid = script["id"]
    work_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = work_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    print(f"[1/9] Synthesizing voice with timestamps...")
    voice_mp3 = assets_dir / "voice.mp3"
    align_json = work_dir / "alignment.json"
    if not voice_mp3.exists() or not align_json.exists():
        synth_voice_with_alignment(script["voiceover"], voice_mp3, align_json)
    alignment = json.loads(align_json.read_text())
    actual_dur = voice_duration_sec(voice_mp3)
    print(f"  voice.mp3 ready, duration = {actual_dur:.2f}s")

    # Build duration: pad 0.3s to let final caption breathe
    duration = max(script.get("duration_sec", actual_dur), actual_dur + 0.3)
    duration = round(duration, 3)

    print(f"[2/9] Grouping characters into words...")
    words = chars_to_words(alignment)
    print(f"  got {len(words)} words")

    print(f"[3/9] Deriving {TARGET_SCENES} scene timings from word boundaries...")
    scene_timings = derive_scene_timings(words, duration, count=TARGET_SCENES)
    for i, sc in enumerate(scene_timings):
        print(f"  scene {i+1}: start={sc['start']:.2f} duration={sc['duration']:.2f}")

    print(f"[4/9] Building caption blocks...")
    caption_blocks = build_caption_blocks(words, scene_timings)

    print(f"[5/9] Fetching {TARGET_SCENES} UNIQUE B-roll stills from Pexels...")
    script_scenes = script.get("scenes", [])
    # Pre-build a pool of unique photos per query so we never repeat
    used_ids = set()
    photo_pool = {}  # query -> [(id, url), ...] remaining unused
    def get_photo(query):
        if query not in photo_pool: photo_pool[query] = []
        # Refill if empty
        if not photo_pool[query]:
            page = 1
            while not photo_pool[query] and page <= 3:
                pool = fetch_pexels_pool(query, n=10, page=page)
                photo_pool[query] = [(pid, url) for (pid, url) in pool if pid not in used_ids]
                page += 1
        if photo_pool[query]:
            pid, url = photo_pool[query].pop(0)
            used_ids.add(pid)
            return (pid, url)
        return (None, None)

    for i, sc in enumerate(scene_timings):
        topic = "kitchen_table_laptop"
        if script_scenes and i < len(script_scenes):
            topic = script_scenes[i].get("broll_topic", topic)
        elif script_scenes:
            topic = script_scenes[i % len(script_scenes)].get("broll_topic", topic)

        img = assets_dir / f"scene_{i+1:02d}.jpg"
        # PRIORITY 1: Local SHG asset (real screenshot)
        local_filename = LOCAL_ASSETS.get(topic)
        local_path = SCRIPT_DIR / "assets" / "static" / local_filename if local_filename else None
        if local_path and local_path.exists():
            import shutil
            shutil.copy(local_path, img)
            print(f"  scene_{i+1:02d}.jpg <- LOCAL {local_filename} ({img.stat().st_size//1024} KB)")
            continue
        # PRIORITY 2: Pexels stock for money/non-brand topics
        q = TOPIC_QUERIES.get(topic, topic.replace("_", " "))
        pid, url = get_photo(q)
        if not url:
            # Try a sibling query (one of our wider fallbacks)
            for alt in ["entrepreneur laptop", "creator economy", "small business owner", "online business desk"]:
                pid, url = get_photo(alt)
                if url:
                    print(f"  scene_{i+1:02d}.jpg fallback to '{alt}'", file=sys.stderr)
                    q = alt
                    break
        if url:
            try:
                with open(img, "wb") as f:
                    f.write(http_get(url))
                print(f"  scene_{i+1:02d}.jpg <- '{q}' pexels_id={pid} ({img.stat().st_size//1024} KB)")
            except Exception as e:
                print(f"  scene_{i+1:02d}.jpg pexels download fail: {e} -> cream", file=sys.stderr)
                fallback_cream_image(img)
        else:
            print(f"  scene_{i+1:02d}.jpg no photo available, using cream", file=sys.stderr)
            fallback_cream_image(img)

    print(f"[6/9] Generating ambient music ({duration:.2f}s)...")
    generate_music(duration, assets_dir / "music.aac")

    print(f"[7/9] Rendering HTML template...")
    # Mark first scene as "hook" so the gradient softens
    scenes_for_tpl = []
    for i, sc in enumerate(scene_timings):
        scenes_for_tpl.append({
            "n": i + 1,
            "start": sc["start"],
            "duration": sc["duration"],
            "image": f"scene_{i+1:02d}.jpg",
            "hook": i < 4,
        })
    ctx = {
        "duration_sec": duration,
        "scenes": scenes_for_tpl,
        "captions": caption_blocks,
    }
    html_text = render_template(ctx)
    (work_dir / "index.html").write_text(html_text)
    (work_dir / "hyperframes.json").write_text(json.dumps(PROJECT_HYPERFRAMES_JSON, indent=2))
    (work_dir / "meta.json").write_text(json.dumps({"id": sid, "name": sid}, indent=2))

    print(f"[8/9] Spawning HyperFrames render (Chromium @ 30fps)...")
    # We run hyperframes against the work_dir as the project root.
    hf_version = os.environ.get("HYPERFRAMES_VERSION", "0.5.4")
    render_log = work_dir / "hyperframes.log"
    cmd = ["npx","--yes",f"hyperframes@{hf_version}","render",
           str(work_dir),
           "-o", str(out_mp4),
           "-f","30",
           "-q","high",
           "--quiet"]
    print(f"  cmd: {' '.join(cmd)}")
    with open(render_log, "wb") as logf:
        proc = subprocess.run(cmd, stdout=logf, stderr=subprocess.STDOUT)
    if proc.returncode != 0:
        tail = render_log.read_text(errors="replace")[-4000:]
        print(tail, file=sys.stderr)
        raise RuntimeError(f"hyperframes render exited {proc.returncode}")
    print(f"  rendered: {out_mp4} ({out_mp4.stat().st_size//1024} KB)")

    print(f"[9/9] Sanity-checking midpoint frame...")
    mid_frame = work_dir / "_sanity_mid.png"
    midpoint = duration / 2
    subprocess.run(["ffmpeg","-y","-loglevel","error","-ss",str(midpoint),"-i",str(out_mp4),
                    "-frames:v","1", str(mid_frame)], check=True)
    try:
        from PIL import Image
        im = Image.open(mid_frame).convert("RGB").resize((40,40))
        pixels = list(im.getdata())
        cream_count = sum(1 for p in pixels if all(c > 225 for c in p))
        cream_pct = cream_count / len(pixels)
        avg = tuple(sum(p[i] for p in pixels)//len(pixels) for i in range(3))
        print(f"  midpoint sanity: avg_rgb={avg} cream_pct={cream_pct:.1%}")
        if cream_pct > 0.85:
            raise RuntimeError(f"Midpoint frame is overwhelmingly cream — render likely missing B-roll.")
    except ImportError:
        pass
    return out_mp4

# ------------------------------------------------------------------ R2 upload
def upload_r2(local_path, r2_key):
    bucket = os.environ.get("R2_BUCKET", "shg-videos")
    domain = os.environ.get("R2_PUBLIC_DOMAIN", "pub-404744d3257c4094982b374d0827c547.r2.dev")
    cmd = ["npx","--yes","wrangler@4","r2","object","put",
           f"{bucket}/{r2_key}", "--file", str(local_path),
           "--content-type", "video/mp4", "--remote"]
    subprocess.run(cmd, check=True)
    return f"https://{domain}/{r2_key}"

# ------------------------------------------------------------------ main
def main():
    if len(sys.argv) < 2:
        print("Usage: render_hyperframes.py <script.json> [skip_upload]"); sys.exit(2)
    script_path = Path(sys.argv[1])
    skip_upload = "skip_upload" in sys.argv
    script = json.loads(script_path.read_text())
    sid = script["id"]
    work = WORK / sid; work.mkdir(parents=True, exist_ok=True)
    out_mp4 = work / f"{sid}.mp4"

    print(f"=== HyperFrames render: {sid} ===")
    t0 = time.time()
    render(script, work, out_mp4)
    print(f"OK rendered in {time.time()-t0:.1f}s -> {out_mp4} ({out_mp4.stat().st_size//1024} KB)")

    if not skip_upload:
        url = upload_r2(out_mp4, f"{sid}.mp4")
        print(f"UP uploaded -> {url}")
        gho = os.environ.get("GITHUB_OUTPUT")
        if gho:
            with open(gho, "a") as f:
                f.write(f"video_url={url}\n")
                f.write(f"video_size_bytes={out_mp4.stat().st_size}\n")

if __name__ == "__main__":
    main()
