import { now, sql } from './http.mjs';

export default {
  async scheduled(_controller, env) {
    const time = now();
    await env.DB.batch([
      sql(env.DB, 'DELETE FROM uploads WHERE expires <= ?', time),
      sql(env.DB, 'DELETE FROM sessions WHERE activity_at <= ? OR authenticated_at <= ?', time - 1800, time - 28800),
      sql(env.DB, 'DELETE FROM rate_limits WHERE started_at < ?', time - 86400),
      sql(env.DB, 'DELETE FROM cover_claims WHERE expires <= ?', time),
    ]);
  },
};
