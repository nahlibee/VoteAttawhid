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

The first visit to `/admin` asks for two codes: one for the supervisor, one to give to the counting teams.

All data is saved in `data/vote.json` after every action. A backup copy is made each time the server starts.

## On the day

1. **Members** tab: paste the member list (one name per line, a column copied from Excel works).
2. **Settings** tab: enter the number of members expected and the number present.
3. **Rounds** tab: create a round, press "open", and the teams start entering papers. Close it when all papers are in, enter the number of cancelled papers, then publish.
4. Each round offers a button that prepares the next one from its results (candidates already filled in).

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
- A draw for the last place is shown with the names concerned; the supervisor decides what to do (usually a re-vote round between them).
- A paper with too few or too many names is cancelled: the team hands it to the supervisor, who enters the count of cancelled papers.
- In the nomination round a team can add a name that is not on the list. It is marked "not a member" and is not counted among the candidates, unless the supervisor marks that person as a member, in which case the votes already entered count at once.
- The approval of the two vice-presidents is counted on the podium and is not in the app.

### Entry shortcuts for the teams

- Nomination: type the first letters, `Enter` picks the name, `Enter` on the empty field saves the paper, `Backspace` removes the last name.
- Candidate rounds: press the candidate's number, then `Enter`.
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

## Tests

```bash
npm test
```
