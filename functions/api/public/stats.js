// /api/public/stats — public member counter + prize pool snapshot
// No auth; only returns aggregates safe for landing page.

export async function onRequestGet({ env }) {
  const result = {
    paid_members: 0,
    threshold: 100,
    prize_pool_cents: 0,
    contest_active: false,
    agents_online: 0,
    agents_total: 11,
    last_signup_at: null,
    submissions_count: 0,
    cached_at: new Date().toISOString(),
  };

  try {
    const m = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(signup_date) AS last
       FROM members WHERE status='active'`
    ).first();
    result.paid_members = m?.n || 0;
    result.last_signup_at = m?.last || null;

    const pool = await env.DB.prepare(
      `SELECT pool_cents, contest_active FROM prize_pool_state ORDER BY period_start DESC LIMIT 1`
    ).first();
    if (pool) {
      result.prize_pool_cents = pool.pool_cents || 0;
      result.contest_active = !!pool.contest_active;
    }

    const fleet = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM agent_status WHERE health IN ('green','yellow')`
    ).first();
    result.agents_online = fleet?.n || 0;

    // Submission count — count discord forum threads in #the-exchange (1502427447017078847)
    // For now, hardcode the seed count (12 starter Hustle Cards).
    result.submissions_count = 12;
  } catch (e) { /* table missing in dev — return zeros gracefully */ }

  return new Response(JSON.stringify(result), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60", // 1 minute browser cache
      "access-control-allow-origin": "*",
    }
  });
}
