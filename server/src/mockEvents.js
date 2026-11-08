// Synthetic PingOne events for Mock mode, built in the REAL delivery schema ("Ping Activity": id, recordedAt, correlationId,
// action.type, actors.user / actors.client with their environment, resources[], result.status) so they go through the SAME parser as a
// real delivery. Every id is a fixed fake. Event names marked `measured` were seen on a real tenant's feed (see FACTS in eventsData.js);
// the rest are illustrative and labelled UNVERIFIED in the story.
export const MOCK_ENV = '00000000-0000-4000-8000-0000000000e1';
const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const MOCK_SCENARIOS = {
  'signin-success': { names: ['FLOW.CREATED', 'PASSWORD.CHECK_SUCCEEDED', 'USER.ACCESS_ALLOWED', 'SESSION.CREATED'], measured: true },
  'failed-password': { names: ['FLOW.CREATED', 'PASSWORD.CHECK_FAILED', 'PASSWORD.CHECK_FAILED', 'USER.ACCESS_DENIED'], measured: false },
  'mfa-step-up': { names: ['FLOW.UPDATED', 'DEVICE_AUTHENTICATION.CHALLENGED', 'DEVICE_AUTHENTICATION.SUCCEEDED', 'SESSION.UPDATED'], measured: false },
  'flow-lifecycle': { names: ['FLOW.CREATED', 'FLOW.UPDATED', 'FLOW.DELETED'], measured: true },
  'session-update': { names: ['SESSION.UPDATED', 'SESSION.UPDATED', 'SESSION.DELETED'], measured: true },
  'risk-evaluation': { names: ['RISK_EVALUATION.COMPLETED', 'USER.UPDATED'], measured: false },
};
export const MOCK_SCENARIO_IDS = Object.keys(MOCK_SCENARIOS);

const STATUS = { 'FLOW.CREATED': 'SIGN_ON_REQUIRED', 'PASSWORD.CHECK_FAILED': 'FAILED', 'USER.ACCESS_DENIED': 'FAILED', 'RISK_EVALUATION.COMPLETED': 'HIGH', 'FLOW.UPDATED': 'MFA_REQUIRED' };
const ACTOR_USER = new Set(['PASSWORD.CHECK_SUCCEEDED', 'PASSWORD.CHECK_FAILED', 'USER.ACCESS_ALLOWED', 'USER.ACCESS_DENIED', 'USER.UPDATED', 'DEVICE_AUTHENTICATION.CHALLENGED', 'DEVICE_AUTHENTICATION.SUCCEEDED']);

// The raw activities of one scenario run. `seq` makes ids unique per run; `now` anchors the timestamps (one per second, oldest first).
export function scenarioActivities(id, cast, { seq = 1, now = Date.now() } = {}) {
  const sc = MOCK_SCENARIOS[id];
  if (!sc) return null;
  const correlationId = uuid(seq * 1000 + 999);
  const env = { id: MOCK_ENV };
  return sc.names.map((type, i) => {
    const asUser = ACTOR_USER.has(type);
    return {
      id: uuid(seq * 1000 + i + 1),
      recordedAt: new Date(now - (sc.names.length - 1 - i) * 1000).toISOString(),
      correlationId,
      action: { type, description: type.replace(/[._]/g, ' ').toLowerCase() },
      actors: { client: { id: CLIENT_ID, name: cast.castClientId, environment: env }, ...(asUser ? { user: { id: USER_ID, name: 'demo-user', environment: env } } : {}) },
      resources: [{ id: uuid(5000 + (i % 3)), type: type.split('.')[0], name: `${cast.castBrand} ${type.split('.')[0].toLowerCase()}` }],
      result: { status: STATUS[type] || 'SUCCESS' },
    };
  });
}

// A hand-written body of the kind people send with curl: a top-level `type`. The parser accepts it only because there is no `action`.
export const handWritten = (cast) => [{ type: 'AUTHENTICATION', result: { status: 'SUCCESS' }, note: `hand-written test for ${cast.castBrand}` }];
