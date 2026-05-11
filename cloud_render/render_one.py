#!/usr/bin/env python3
"""
Render one SHG short-form video from a script.json.

Pipeline:
  1. Load script.json (voiceover + scenes + captions)
  2. Generate voice via ElevenLabs (cached if same VO text)
  3. Fetch 1 B-roll still per scene from Pexels (topic-keyed)
  4. Generate ambient music via FFmpeg sine triad
  5. Compose with FFmpeg: stills + voice + music + burned-in captions
  6. Upload finished MP4 to R2

Output: 1080x1920 MP4, 10 seconds, ready to post.
"""
import os, sys, json, hashlib, urllib.request, urllib.error, urllib.parse, subprocess, base64, time
from pathlib import Path

ROOT = Path(__file__).parent
WORK = Path(os.environ.get("WORKDIR", "/tmp/shg_render"))
WORK.mkdir(parents=True, exist_ok=True)

# Brand voice settings (locked in the_side_hustle_guild.yaml)
VOICE_ID  = "kdmDKE6EkgrWrrykO9Qt"   # Alexandra — warm friendly female
MODEL_ID  = "eleven_turbo_v2_5"
VOICE_SETTINGS = {"stability":0.50,"similarity_boost":0.75,"style":0.30,"use_speaker_boost":True}
WIDTH, HEIGHT = 1080, 1920

INK    = "#27384A"   # slate
PAPER  = "#F8F4ED"   # cream
SUNRISE= "#E89B3B"   # amber
SAGE   = "#A8C9A0"

def env(k, required=True):
    v = os.environ.get(k)
    if required and not v: raise RuntimeError(f"Missing env: {k}")
    return v

def post_json(url, headers, body, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
        headers={**headers, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def get(url, headers=None, timeout=20):
    h = {"User-Agent": "SHG-RenderFarm/1.0 (+https://thesidehustleguild.com)"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

# ------------------------------------------------------------------ ElevenLabs
def synth_voice(text, out_path):
    """Synthesize voice with ElevenLabs Turbo v2.5."""
    api_key = env("ELEVENLABS_API_KEY")
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    body = {
        "text": text,
        "model_id": MODEL_ID,
        "voice_settings": VOICE_SETTINGS,
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
        headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg",
                 "User-Agent": "SHG-RenderFarm/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out_path.write_bytes(r.read())
    return out_path

def voice_duration_sec(mp3):
    out = subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration",
                                   "-of","default=noprint_wrappers=1:nokey=1", str(mp3)]).decode().strip()
    return float(out)

# ------------------------------------------------------------------ Pexels
def fetch_pexels(query, out_path):
    """Fetch one landscape photo from Pexels matching query."""
    api_key = env("PEXELS_API_KEY")
    qs = urllib.parse.urlencode({"query": query, "per_page": 5, "orientation": "portrait"})
    url = f"https://api.pexels.com/v1/search?{qs}"
    data = json.loads(get(url, headers={"Authorization": api_key}))
    photos = data.get("photos", [])
    if not photos:
        # Fallback: simpler query
        qs2 = urllib.parse.urlencode({"query": query.split()[0], "per_page": 5, "orientation": "portrait"})
        data = json.loads(get(f"https://api.pexels.com/v1/search?{qs2}", headers={"Authorization": api_key}))
        photos = data.get("photos", [])
    if not photos:
        raise RuntimeError(f"No Pexels photos for {query}")
    src = photos[0]["src"]["large2x"]
    out_path.write_bytes(get(src))
    return out_path

# ------------------------------------------------------------------ FFmpeg compose
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
}

def hex_to_ass(hex_color):
    h = hex_color.lstrip("#")
    return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}&"

def build_ass(captions, duration, out_path):
    """Build a clean ASS subtitle file with brand styling."""
    primary = hex_to_ass(INK)
    outline = hex_to_ass(PAPER)
    back    = "&H80000000"
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: SHG, DejaVu Sans, 92, {primary}, {primary}, {outline}, {back}, 1, 0, 0, 0, 100, 100, 0, 0, 3, 14, 4, 5, 80, 80, 0, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    def to_ass_time(t):
        h = int(t // 3600); m = int((t % 3600) // 60); s = t - 60*int(t//60); cs = int((s - int(s)) * 100); s = int(s)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"
    lines = [head]
    for c in captions:
        text = c["text"].replace("\n", "\\N")
        lines.append(f"Dialogue: 0,{to_ass_time(c['start'])},{to_ass_time(c['end'])},SHG,,0,0,0,,{text}")
    out_path.write_text("\n".join(lines))

def render(script, work_dir, out_mp4):
    sid = script["id"]
    duration = script["duration_sec"]

    # Voice
    voice_mp3 = work_dir / "voice.mp3"
    if not voice_mp3.exists():
        synth_voice(script["voiceover"], voice_mp3)
    actual_dur = voice_duration_sec(voice_mp3)

    # Use the actual voice duration (round up to nearest 0.5)
    duration = max(duration, actual_dur + 0.3)

    # B-roll per scene
    scene_imgs = []
    for i, sc in enumerate(script["scenes"]):
        topic = sc.get("broll_topic","kitchen_table_laptop")
        q = TOPIC_QUERIES.get(topic, topic.replace("_", " "))
        img = work_dir / f"scene_{i+1:02d}.jpg"
        try: fetch_pexels(q, img)
        except Exception as e:
            print(f"  pexels fail {topic}: {e}", file=sys.stderr)
            # Cream fallback
            subprocess.run(["ffmpeg","-y","-loglevel","error","-f","lavfi",
                            "-i", f"color=c={PAPER}:s={WIDTH}x{HEIGHT}:d=1",
                            "-frames:v","1", str(img)], check=True)
        scene_imgs.append(img)
    # No padding — use exactly the scenes the script defines
    if len(scene_imgs) == 0:
        cream = work_dir / "scene_fallback.jpg"
        subprocess.run(["ffmpeg","-y","-loglevel","error","-f","lavfi",
                        "-i", f"color=c={PAPER}:s={WIDTH}x{HEIGHT}:d=1",
                        "-frames:v","1", str(cream)], check=True)
        scene_imgs.append(cream)

    # Music — A2/A3/E4 warm triad, gentle
    music_aac = work_dir / "music.aac"
    music_filter = (
        "[0:a]volume=0.16[a0];"
        "[1:a]volume=0.10[a1];"
        "[2:a]volume=0.06[a2];"
        "[a0][a1][a2]amix=inputs=3:duration=longest[mixed];"
        f"[mixed]highpass=f=80,lowpass=f=2400,volume=0.30,"
        f"afade=t=in:st=0:d=0.8,afade=t=out:st={duration-1.2}:d=1.2[out]"
    )
    subprocess.run(["ffmpeg","-y","-loglevel","error",
                    "-f","lavfi","-t",str(duration),"-i","sine=frequency=110:sample_rate=44100",
                    "-f","lavfi","-t",str(duration),"-i","sine=frequency=220:sample_rate=44100",
                    "-f","lavfi","-t",str(duration),"-i","sine=frequency=330:sample_rate=44100",
                    "-filter_complex", music_filter, "-map","[out]",
                    "-c:a","aac","-b:a","128k", str(music_aac)], check=True)

    # ASS captions
    ass = work_dir / "captions.ass"
    build_ass(script["captions"], duration, ass)

    # Compose: scenes as a slideshow with crossfade, voice + music ducked, captions burned in
    # Per-scene durations from script
    scene_durs = []
    for i, sc in enumerate(script["scenes"]):
        scene_durs.append(sc["end"] - sc["start"])
    # Pad to 3 scenes
    # Use whatever scene_durs the script provided

    # Build the input list: each image looped for its scene duration
    inputs = []
    for img, d in zip(scene_imgs, scene_durs):
        inputs += ["-loop","1","-t",f"{d}", "-i", str(img)]
    inputs += ["-i", str(voice_mp3), "-i", str(music_aac)]

    # Filter: scale+crop each image to 1080x1920 with subtle Ken Burns zoom, concat, overlay captions
    n = len(scene_imgs)
    fc_parts = []
    for i, d in enumerate(scene_durs):
        fps = 30
        nframes = int(d * fps)
        # Slight slow zoom
        fc_parts.append(
          f"[{i}:v]scale={WIDTH*1.1:.0f}:{HEIGHT*1.1:.0f}:force_original_aspect_ratio=increase,"
          f"crop={WIDTH}:{HEIGHT},"
          f"zoompan=z='min(zoom+0.0008,1.10)':d={nframes}:s={WIDTH}x{HEIGHT}:fps={fps},"
          f"setsar=1[v{i}]"
        )
    concat_inputs = "".join(f"[v{i}]" for i in range(n))
    fc_parts.append(f"{concat_inputs}concat=n={n}:v=1:a=0[vbase]")
    fc_parts.append(f"[vbase]subtitles='{ass}':fontsdir=/usr/share/fonts:original_size={WIDTH}x{HEIGHT}[vout]")
    fc_parts.append(f"[{n}:a]volume=1.0[voice]")
    fc_parts.append(f"[{n+1}:a]volume=0.30[music]")
    fc_parts.append(f"[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]")
    filter_complex = ";".join(fc_parts)

    cmd = ["ffmpeg","-y","-hide_banner","-loglevel","warning"] + inputs + [
        "-filter_complex", filter_complex,
        "-map","[vout]","-map","[aout]",
        "-c:v","libx264","-pix_fmt","yuv420p","-r","30","-preset","medium","-crf","20",
        "-c:a","aac","-b:a","192k",
        "-t", str(duration),
        "-movflags","+faststart",
        str(out_mp4)
    ]
    subprocess.run(cmd, check=True)
    # Sanity check: extract a frame at the midpoint, verify B-roll actually rendered
    mid_frame = work_dir / "_sanity_mid.png"
    midpoint = duration / 2
    subprocess.run(["ffmpeg","-y","-loglevel","error","-ss",str(midpoint),"-i",str(out_mp4),
                    "-frames:v","1", str(mid_frame)], check=True)
    try:
        from PIL import Image
        im = Image.open(mid_frame).convert("RGB").resize((40,40))
        pixels = list(im.getdata())
        avg = tuple(sum(p[i] for p in pixels)//len(pixels) for i in range(3))
        cream_count = sum(1 for p in pixels if all(c > 225 for c in p))
        cream_pct = cream_count / len(pixels)
        print(f"  sanity: avg_rgb={avg} cream_pct={cream_pct:.1%}")
        if cream_pct > 0.85:
            raise RuntimeError(f"Video appears cream-only at midpoint (cream_pct={cream_pct:.1%}). B-roll likely failed.")
    except ImportError:
        subprocess.run(["pip","install","Pillow","--quiet"], check=True)
        # re-run check
        from PIL import Image
        im = Image.open(mid_frame).convert("RGB").resize((40,40))
        pixels = list(im.getdata())
        cream_count = sum(1 for p in pixels if all(c > 225 for c in p))
        if cream_count / len(pixels) > 0.85:
            raise RuntimeError("Video appears cream-only at midpoint. B-roll likely failed.")
    return out_mp4

# ------------------------------------------------------------------ R2 upload
def upload_r2(local_path, r2_key):
    """Upload via wrangler r2 object put (uses CLOUDFLARE_API_TOKEN env)."""
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
        print("Usage: render_one.py <script.json> [skip_upload]"); sys.exit(2)
    script_path = Path(sys.argv[1])
    skip_upload = "skip_upload" in sys.argv
    script = json.loads(script_path.read_text())
    sid = script["id"]
    work = WORK / sid; work.mkdir(parents=True, exist_ok=True)
    out_mp4 = work / f"{sid}.mp4"

    print(f"=== Rendering {sid} ===")
    t0 = time.time()
    render(script, work, out_mp4)
    print(f"  ✅ rendered in {time.time()-t0:.1f}s → {out_mp4} ({out_mp4.stat().st_size//1024} KB)")

    if not skip_upload:
        url = upload_r2(out_mp4, f"{sid}.mp4")
        print(f"  📤 uploaded → {url}")
        print(f"::set-output name=video_url::{url}")

if __name__ == "__main__":
    main()
