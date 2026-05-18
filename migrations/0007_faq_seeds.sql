-- 0007_faq_seeds — 12 launch-day FAQ tag answers for SHG members.
-- Fired via /faq <name> slash command, auto-trigger keywords, or mod /tag/post.

-- Idempotent re-seed: clear any previous seed values then insert fresh.

INSERT INTO faq_tags (name, title, content, embed_color, created_by) VALUES

-- 1. The contest mechanics
('contest', '🏆 How the monthly contest works',
'Every month, 25% of every subscription dollar becomes the cash prize pool. Submit your Hustle Card by the 28th, judges score on the 29th-30th, winners paid out by the 1st of the next month.

**Pool math (real-time):** thesidehustleguild.com/submissions

**Judging rubric (5 axes, each scored 1-10):**
1. Quality of execution
2. Specificity (a real thing built, not a vague plan)
3. Replicability (other members can learn from this)
4. Story arc (problem → action → outcome)
5. Bonus: helped another member ship something

Top 3 split the pool: 50% / 30% / 20%. All judging notes go live publicly with the winners.

**Submit:** https://thesidehustleguild.com/submit',
2701384, 'shg_launch_seed'),

-- 2. Pricing + founder rate
('pricing', '💰 Pricing — founder rate vs standard',
'**$9/mo founder rate** — first 50 paid members. Locked for life as long as your sub stays active.
**$19/mo standard** — when founder seats sell out.
**$99/yr** (≈ $8.25/mo) — annual, locked for life.

Founders get the same access as standard members. The rate locks if you cancel and re-join later — you re-enter at whatever the current public rate is.

**Pause your sub anytime** (Whop dashboard → Memberships → Pause) — pause preserves your founder rate and contest history.

Cancel: same dashboard. Refund: 7-day no-questions-asked from initial purchase.',
13139489, 'shg_launch_seed'),

-- 3. Payouts + W-9
('payouts', '💸 How prize payouts work',
'**When:** winners announced day 30, paid via Stripe by day 7 of the next month.

**Where the money comes from:** your Stripe email on file. We DM you to confirm the email, then dispatch — usually within 48 hours of confirmation.

**Taxes (US winners):**
• Cumulative prize <$2,000/calendar year: no W-9, no 1099. Pay out, done.
• Cumulative ≥$2,000/year: we collect a W-9 BEFORE the next payout. You stay eligible — there''s just a tax form in the loop.

**Taxes (international):** 30% federal withholding by default. W-8BEN reduces that if your country has a treaty.

**If you don''t respond within 14 days** of the winner DM, the prize forfeits to the next month''s pool. We send a 7-day nudge first.

Questions: open a ticket → Billing.',
2701384, 'shg_launch_seed'),

-- 4. Affiliate program
('affiliate', '🤝 The affiliate program',
'30% recurring commission on every paying referral, for as long as they''re subscribed. 30-day cookie window.

**How to start:**
1. thesidehustleguild.com/affiliate → grab your link
2. Share it. Anywhere honest.
3. Get paid via Stripe Connect, the 5th of each month (>$10 threshold).

**The honest stuff:**
• No multi-tier / MLM — single-level only
• Self-referral is blocked (members can''t use their own link)
• Refunds within 30 days clawback the commission
• W-9 collected after $600 cumulative/year per IRS rules

**Question that comes up:** *"Can I run paid ads to my link?"* Yes, with two rules — no fake testimonials, no impersonating SHG official channels.',
15375675, 'shg_launch_seed'),

-- 5. How to make your first dollar
('first-dollar', '🚀 Earn your first dollar in the Guild',
'Three lowest-effort paths members have actually used:

**1. The 60-second swap** (#free-swap-board)
Trade a small skill for a small skill. You''ll find someone who needs the exact thing you''re good at. First proof that what you do has value.

**2. The Hustle Card → contest pool** (#the-exchange)
Build the smallest version of your thing this week. Submit it as a Hustle Card by the 28th. Top 3 split the monthly pool. Even 3rd place is real money.

**3. The DM-after-Office-Hours**
Wednesday voice. Bring something stuck. Someone with the answer almost always offers to help — and often that turns into a paid gig within a week.

**The pattern:** ship something tiny, get one real response, ask if they''d pay for X next time. Most members earn their first $50 in 2-3 weeks doing this.

You''re not waiting on us. The room is full of people who''ll trade money for the thing you''re already doing.',
2701384, 'shg_launch_seed'),

-- 6. Hustle Card format
('hustle-card', '📇 What a Hustle Card is (and how to submit)',
'A Hustle Card is a structured post about one specific thing you built or shipped. Lives at thesidehustleguild.com/submit.

**5 short fields + image upload, ~6 min to fill:**
1. **Title** — one line, what it is
2. **Problem** — who was stuck, on what
3. **What you built** — the thing itself
4. **Outcome** — real numbers if you have them (revenue, customers, time saved)
5. **Screenshots** — first one is your hero image (entries with images get 3× the reactions)

It auto-posts to #the-exchange when you submit. Top entries get judged for the monthly contest.

**Tip:** A scrappy first version beats a polished pitch. Judges score specificity > polish. *"Sold 4 copies of a Notion template for $19 each in the first week"* beats *"Launched my premium digital product line."*',
2701384, 'shg_launch_seed'),

-- 7. Office Hours
('office-hours', '🎙 Wednesday Office Hours',
'**Wednesday 12pm ET · 30 min · Discord Stage Channel**

No slides. No agenda. Bring the one thing you''re stuck on. I take questions in the order they show up.

**Things that work well to bring:**
• Pricing a digital product
• When to launch vs polish more
• What to do when nobody''s buying
• How to land the first paying client
• When to quit a side project

**Can''t make it live?** Drop your question in the thread that goes up Tuesday. I''ll answer it on the recording.

**Recording posted within 24 hours** in #wednesday-office-hours.

Sesh event card lives in #announcements every Tuesday — RSVP there for a reminder.',
15375675, 'shg_launch_seed'),

-- 8. The weekly rhythm
('rhythm', '🗓 The weekly rhythm — what to expect',
'Three named rituals, same day every week:

**Monday** — Week''s theme drops in #monday-drops. Pick one thing, ship by Friday.
**Tuesday** — Tool Talk: a real review of a real builder tool (Notion, Stripe, Cal.com, etc.).
**Wednesday** — Niche-track prompt (rotating audience) + Office Hours at noon ET.
**Thursday** — Niche update + organic conversation in #the-exchange.
**Friday** — Wins thread in #wins-of-the-month. Drop yours. I reply to every one.
**Saturday** — Marketplace seed in #free-swap-board.
**Sunday** — Reset note. Three reflective prompts for the week ahead.

Every monthly cycle layers on a 4-week shape: week 1 office hours · week 2 workshop · week 3 hot seats · week 4 drop day.

You don''t have to show up to every ritual. Pick the 2-3 that fit your week.',
13139489, 'shg_launch_seed'),

-- 9. Tools to start with
('tools', '🛠 Tools to start with (free tier where possible)',
'**Charging money:** Gumroad (digital products, paid same day, $1.99 setup) · Stripe Payment Links (lowest fee, requires Stripe Connect)
**Landing pages:** Carrd ($19/yr unlimited) · Webflow free tier (1 site)
**Email list:** ConvertKit free up to 1K subs · Beehiiv free up to 2.5K
**Tracking work:** Notion free for individuals · Linear free for solo
**Recording loom-style video:** Loom free (25 vids, 5 min each) · Tella free tier
**Booking calls:** Cal.com free unlimited · SavvyCal $12/mo
**Polished social videos:** Veed.io · CapCut
**Cold email:** Apollo.io free tier (50 contacts/day)

**Skip on day 1:** an LLC, a logo designer, a "personal brand" course, anything subscription >$30/mo. You don''t need them to earn your first $1K.

Every Tuesday in #tuesday-tool-talk, c3 drops one specific tool review with where it falls short.',
15375675, 'shg_launch_seed'),

-- 10. The Sunday Reset
('sunday-reset', '🌅 The Sunday Reset (free lead magnet)',
'A 5-minute weekly ritual we built. Print it once, run it every Sunday.

**Three prompts:**
1. One thing that actually worked this week — be specific
2. One thing that didn''t — don''t sugarcoat
3. One thing you''re moving on Monday morning, first hour

That''s it. Most builders never look back at their own week, which is why month two looks identical to month one.

**Print it:** https://thesidehustleguild.com/sunday-reset-planner/

We post a fresh Sunday Reset note in #announcements every Sunday evening. Same structure, light variation. Read it, fill yours out, you''re set.',
2701384, 'shg_launch_seed'),

-- 11. Code of conduct
('rules', '📋 The 5 rules of the Guild',
'**1. Build, don''t broadcast.** Talking about your hustle is welcome. Promoting unrelated services / spamming links / cold-DMing other members is not.

**2. No NSFW, no exceptions.** Violations = ban.

**3. No partisan politics, no religious proselytizing.** Content-neutral focus — we''re here to build, not debate.

**4. Trade help freely, charge fairly.** Free help is great. Paid services advertised must be in #for-sale-marketplace, must include a real price, and must be something you''d sell to a stranger.

**5. Don''t harass, threaten, doxx, or be cruel.** First-offense for these = immediate ban, no warnings.

**For everything else:** Joshua moderates with a public correction (one line) and a DM for the conversation. Reasonable mistakes are reasonable. Patterns aren''t.

Mods follow Discord''s Community Guidelines + the Server Rules pinned in #rules. Full version: thesidehustleguild.com/terms',
13139489, 'shg_launch_seed'),

-- 12. Get help
('help', '💬 How to get help fast',
'**For builder questions:** post in #the-exchange. Faster than a ticket, more eyes, often resolved in <1 hour.

**For private things:** open a ticket via the panel in #support. Categories:
🧾 Billing — Whop sub, refund, payout
🏆 Contest — eligibility, judging, prize claim
🐛 Bug — site, Discord, Whop, anything broken
🤝 Sponsor — brands sponsoring a season
💬 Anything else private

**Response within 24h, usually faster.** Real humans read every ticket.

**Joshua direct:** the Wednesday Office Hours stage. Bring your stuck thing. 30 minutes of his time, every week, free.

**Don''t DM Joshua cold** — he reads them but can''t respond to all. A ticket gets a real reply every time.',
2701384, 'shg_launch_seed')
ON CONFLICT(name) DO UPDATE SET
  title       = excluded.title,
  content     = excluded.content,
  embed_color = excluded.embed_color,
  created_by  = excluded.created_by,
  updated_at  = CURRENT_TIMESTAMP,
  enabled     = 1;

-- Verify count
SELECT 'Seeded ' || COUNT(*) || ' FAQ tags' AS result FROM faq_tags WHERE created_by = 'shg_launch_seed';
