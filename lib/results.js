'use strict';
// Vote counting rules. Kept separate from the server so they can be tested alone.

// "50% + 1": half rounded down, plus one (170 -> 86, 171 -> 86).
const majority = (n) => Math.floor(n / 2) + 1;

// Arabic-insensitive name key: ignores diacritics, hamza forms, ta marbuta, etc.
function norm(s) {
  return String(s)
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * round:   {mode:'open'|'list', candidates:[id], seats, threshold:'none'|'absolute'|'present', void}
 * ballots: [{choices:[id]}]
 * people:  [{id, name, isMember}]
 * settings:{expected, present}
 *
 * Row status:
 *   elected   – holds one of the seats
 *   tied      – draw for the last seat(s); needs a decision / re-vote
 *   below     – did not reach the required majority, or ranked under the seats
 *   nonmember – named in a free nomination but not an assembly member
 */
function computeResults(round, ballots, people, settings) {
  const tally = new Map();
  if (round.mode === 'list') for (const id of round.candidates) tally.set(id, 0);
  // Papers recorded as cancelled by a team give no vote to anyone.
  const counted = ballots.filter((b) => !b.cancelled);
  for (const b of counted) for (const id of b.choices) tally.set(id, (tally.get(id) || 0) + 1);

  const byId = new Map(people.map((p) => [p.id, p]));
  const rows = [...tally].map(([id, votes]) => {
    const p = byId.get(id) || { name: '؟', isMember: false };
    return { id, name: p.name, isMember: p.isMember, pending: !!p.pending, votes, status: 'below' };
  }).sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'ar'));

  // "Majority of those present" cannot be computed until the present count is entered.
  const thresholdMissing = round.threshold === 'present' && !(settings.present > 0);
  const threshold = thresholdMissing ? null
    : round.threshold === 'absolute' ? majority(settings.expected)
    : round.threshold === 'present' ? majority(settings.present) : null;

  const eligible = rows.filter((r) => {
    if (round.mode === 'open' && !r.isMember) { r.status = 'nonmember'; return false; }
    if (thresholdMissing) return false;
    return r.votes > 0 && (threshold === null || r.votes >= threshold);
  });

  let elected = eligible;
  let tied = [];
  if (eligible.length > round.seats) {
    const cutoff = eligible[round.seats - 1].votes;
    if (cutoff > eligible[round.seats].votes) {
      elected = eligible.slice(0, round.seats);
    } else {
      elected = eligible.filter((r) => r.votes > cutoff);
      tied = eligible.filter((r) => r.votes === cutoff);
    }
  }
  elected.forEach((r) => { r.status = 'elected'; });
  tied.forEach((r) => { r.status = 'tied'; });

  const valid = counted.length;
  const voidTeams = ballots.length - valid;   // recorded by the teams
  const voidManual = round.void || 0;         // added by the supervisor
  const voided = voidTeams + voidManual;
  return {
    rows,
    threshold,
    thresholdType: round.threshold,
    thresholdMissing,
    valid,
    void: voided,
    voidTeams,
    voidManual,
    total: valid + voided,
    expected: settings.expected,
    present: settings.present,
    seatsLeft: round.seats - elected.length,
  };
}

module.exports = { computeResults, majority, norm };
