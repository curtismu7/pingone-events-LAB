import { fillDeep } from './cast.js';
import { BANNER, DELIVERY_SCENARIOS, FACTS, INTRO, REAL_BANNER, SCENARIOS, SETUP, SINK_SCENARIO_TEXT, TALK_TRACK, TITLE, TOKEN_LABEL } from './eventsData.js';

export const rawStory = () => ({ title: TITLE, intro: INTRO, banner: BANNER, realBanner: REAL_BANNER, scenarios: SCENARIOS, facts: FACTS, talkTrack: TALK_TRACK, deliveryScenarios: DELIVERY_SCENARIOS, sinkScenarios: SINK_SCENARIO_TEXT, setup: SETUP });

// The story with the cast filled in.
export function buildStory(cast) {
  const s = fillDeep(rawStory(), cast);
  return { ...s, tokenLabel: TOKEN_LABEL, cast };
}

// docs/talk-track.md is generated from the same data the UI reads (`npm run talk-track`); a test fails if they drift.
export function renderTalkTrackMarkdown(cast) {
  const s = buildStory(cast);
  const parts = ['# Talk track', '', '<!-- Generated from server/src/eventsData.js by `npm run talk-track`. Do not edit by hand. -->', ''];
  for (const t of s.talkTrack) parts.push(`## ${t.title}`, '', t.say, '');
  parts.push('## The scenarios', '');
  s.scenarios.forEach((sc, i) => parts.push(`${i + 1}. **${sc.title}.** ${sc.lesson}`));
  return `${parts.join('\n')}\n`;
}
