# VoteAttawhid

Web app for counting the paper votes of the regional general assembly: election of the president and of the five members of the regional bureau. The interface is in Arabic.

## Start it

Needs [Node.js](https://nodejs.org) 18 or newer. Nothing else to install.

```bash
node server.js
```

The terminal prints the addresses to open. Three pages:

| Page | Who | What |
|---|---|---|
| `/admin` | Supervisor | Member list, counts, rounds, cancelled papers, live detailed results |
| `/team` | Counting teams | Fast entry of voting papers |
| `/` | Everyone (projector) | Results the supervisor has published |

The first visit to `/admin` asks you to choose the supervisor code. The supervisor then creates the counting teams, and each team gets its own code.

All data is saved in `data/vote.json` after every action. A backup copy is made each time the server starts.

## On the day

1. **Members** tab: paste the member list (one name per line, a column copied from Excel works).
2. **Teams** tab: create one team per counting table and hand each team its code.
3. **Settings** tab: enter the number of members expected and the number present.
4. **Rounds** tab: create a round, press "open", and the teams start entering papers. Close it when all papers are in (cancelled papers are recorded by the teams as they go), then publish.
5. Each round offers a button that prepares the next one from its results (candidates already filled in).

### Rounds

| Round | Each paper | Winner rule |
|---|---|---|
| President: nomination | 3 to 5 names, free | The 5 members with the most votes |
| President: vote | 1 name among the candidates | Absolute majority |
| President: run-off | 1 name among the first two | Majority of those present |
| Bureau: vote | Up to 5 among the president's list | The first 5 who reach the absolute majority |
| Bureau: re-vote | Up to the seats left | Majority of those present |

- Absolute majority = half of the members expected, rounded down, plus one (170 gives 86).
- Majority of those present = the same, from the number present. Cancelled papers do not lower it.
- The number present can be changed at any time (also from the rounds tab). It applies to rounds that are open or not opened yet; a round keeps the numbers it was closed with, so later changes never alter a decided result.
- A draw for the last place is shown with the names concerned; the supervisor decides what to do (usually a re-vote round between them).
- A name written twice (or more) on a paper, or a name that is not a candidate of the round, is removed from it entirely, as if it was never written. The paper then counts for the other names, unless too few remain, in which case it is cancelled.
- A paper that is cancelled (too few or too many names, unreadable, blank…) is recorded by the team with the «ورقة ملغاة» button and the team moves on. Cancelled papers are counted per team, per round and in total; the supervisor can also add cancelled papers handed to them directly.
- In the nomination round a team can add a name that is not on the list and carry on. The name waits for the supervisor, who gets a notice on the supervisor page and accepts it (its votes, including those already entered, count at once), rejects it (its votes never count), or merges it with an existing member. Until then its votes are not counted.
- Only the supervisor creates teams. Each team logs in with its own 5-digit code, which the supervisor hands over in person. A team can be added at any time, even during a round.
- If a code leaks, «رمز جديد» replaces it and logs that team out. A team with no papers can be deleted.
- The approval of the two vice-presidents is counted on the podium and is not in the app.

### Entry shortcuts for the teams

- Nomination: type the first letters, `Enter` picks the name, `Enter` on the empty field saves the paper, `Backspace` removes the last name.
- Candidate rounds: press the candidate's number, then `Enter`. Press `0` for each name on the paper that is not a candidate (not counted).
- A paper entered by mistake can be deleted from the list under the entry area.

## Where to run it

- **In the room, without internet:** run it on one laptop, connect all laptops to the same Wi-Fi router, and open the "Other computers" address printed at start.
- **Online:** deploy on any Node.js host with a persistent disk; set `PORT` and `DATA_DIR` if the host requires it.

## Equipment for the event

- 1 laptop for the supervisor (also runs the app when used without internet), with its charger
- 5 laptops, one per counting team, with chargers; any recent browser
- 1 Wi-Fi router (no internet needed) and power strips
- 1 projector or large screen, plus a laptop or the supervisor's one to show the results page
- 1 printer for the final results (optional; the supervisor page prints directly)
- Blank voting papers, one per member per round (about 170 × 6 to cover re-votes), pens, and a box per team for papers already entered
- A tray for cancelled papers at the supervisor's table

## HTTPS

```bash
./make-cert.sh
```

creates a certificate for the laptop's current addresses in `certs/`; the app then answers in HTTPS and redirects `http://` to it. Run it again when the laptop changes network. Other devices show a warning until `certs/ca.pem` is imported in their browser.

`./start.sh` starts the app, opens the firewall port (firewalld) while it runs, closes it on exit, and keeps the laptop awake.

## Tests

```bash
node --test
```

Browser test of every button and the election scenarios, in a headless Firefox with throwaway data (about 3 minutes):

```bash
node e2e/ui-check.js
```

The test plan, with the manual checklist for every button and the full election scenarios, is in [docs/TEST_PLAN.md](docs/TEST_PLAN.md).
