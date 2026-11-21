# Test plan: VoteAttawhid

This plan checks that the vote counting app gives correct results and that every screen control does what it should, before it is used at the general assembly.

## 1. What is tested, and how

| Level | What it checks | How | Count |
|---|---|---|---|
| Counting rules | Majorities, top five, draws, non-members | Automated, `test/results.test.js` | 32 |
| Screen logic | Name search, result sentences, proposed next round, page scripts valid | Automated, `test/frontend.test.js` | 27 |
| Server | Logins, permissions, team codes, paper entry, duplicate names, publishing, restart, HTTPS | Automated, `test/api.test.js` | 67 |
| Local name | Answers for `voteattawhid.local`, ignores everything else, survives malformed packets | Automated, `test/mdns.test.js` | 4 |
| Buttons and keyboard | Every control on the three pages, with the election scenarios | Automated in Firefox, `e2e/ui-check.js` | 84 checks |
| Full scenarios | A complete election, nominal and not | By hand, section 5 | 9 |
| Event conditions | Several laptops, network, power | By hand, section 6 | 8 |

**Buttons in a real browser:** `e2e/ui-check.js` drives Firefox (headless) like a person: real mouse clicks and key presses, four separate browser sessions (supervisor, two team computers, public screen), over HTTPS. It starts its own copy of the app on a spare port with empty data, so it never touches real votes. It covers section 4 and scenarios S1, S2, S6, S7, S8, S11, plus a server stop and restart during entry. Its output uses the IDs of this plan. What it cannot replace: several physical laptops and a phone on the venue Wi-Fi (section 6), and a look at the screens by a person.

### Run the browser test

```bash
node e2e/ui-check.js
```

Needs Firefox and openssl. Takes about 3 minutes. Expected last line: `84 passed, 0 failed`. Screenshots of any failure are saved in `e2e/out/`.

### Run the automated tests

```bash
node --test
```

Expected last lines: `pass 130`, `fail 0`. It takes about one second. The tests start their own temporary server on a spare port with an empty data folder, so they never touch real votes and can run while the app is in use.

### Rules of reference

| Rule | Value |
|---|---|
| Absolute majority | Half of the members expected, rounded down, plus one (170 gives 86) |
| Majority of those present | Same formula on the present count (160 gives 81) |
| Present count | Can change at any time; applies to rounds not yet closed; a closed round keeps the counts it was closed with |
| Cancelled papers | Set aside by the teams without being entered; examined, counted and added by the supervisor only; give no vote; reported, and do not lower the majority of those present |
| Nomination paper | 3 to 5 names, otherwise set aside for the supervisor |
| President vote candidates | Only names retained by the latest nomination (including those tied for the last place) |
| Run-off candidates | Only candidates of the latest president vote |
| President vote paper | Exactly 1 name |
| Bureau paper | 1 to 5 names from the president's list |
| Draw | Announced with the names; the supervisor decides |
| Name added by a team | Waits for the supervisor («في انتظار المصادقة»); not counted until accepted; rejected stays not counted |
| Name written twice, or not a candidate | Removed from the paper entirely; the limits are then checked on the names left |
| Teams | Created by the supervisor only; each team logs in with its own 5-digit code, on one device at a time |
| Wrong team codes | After 5 wrong codes a device waits 1 minute; other devices are not affected |
| Rejected name | Removed from its papers; a paper left under the minimum counts as cancelled until the name is accepted |
| Open rounds | Only one round can be open at a time |
| History | Every change is recorded with its time and author, without any code; visible to the supervisor only |
| Deleting a paper | A team only asks, for its own paper in an open round; the paper stays counted until the supervisor accepts; a rejected request cannot be sent again |

### Pass criteria

- All 130 automated tests pass.
- Every line of sections 4, 5 and 6 is marked OK, or the failure is understood and accepted in writing by the supervisor.
- A rehearsal of section 5, scenario S1, has been done on the event laptops.

## 2. Automated cases: counting rules

`N` = nominal, `A` = alternative, `F` = failing or refused case.

| ID | Type | Case | Expected |
|---|---|---|---|
| U01 | N | Majority of 170, 171, 160, 161 | 86, 86, 81, 81 |
| U02 | A | Majority of 1, 2, 3 | 1, 2, 2 |
| U03 | N | Same name with or without hamza, ta marbuta, vowels | Recognised as the same name |
| U04 | F | Two close but different names | Kept as different |
| U05 | N | Nomination, 7 names | The 5 with the most votes are kept |
| U06 | A | Nomination, a non-member is first | Left out; the 6th takes the place. Made a member: counted |
| U07 | A | Nomination, 5th and 6th equal | Draw between the two, 1 place open |
| U08 | A | Nomination, 3 names equal for the last 2 places | Draw between the three, 2 places open |
| U09 | A | Nomination, only 3 names received votes | All 3 kept, 2 places open |
| U10 | A | Nomination, 6 names all equal | Draw between all six |
| U11 | N | Papers with several names | One vote for each name on the paper |
| U12 | N | President, 86 votes of 170 expected | Elected |
| U13 | F | President, 85 votes | Not elected, seat open |
| U14 | F | President, 82 votes with 160 present | Not elected: the expected count is used, not the present count |
| U15 | A | Candidate with no vote | Listed with 0 |
| U16 | F | Round with no paper | Nobody elected |
| U17 | N | Run-off, 81 votes with 160 present | Elected |
| U18 | F | Run-off, 80 votes, 10 cancelled papers | Not elected: majority stays 81 |
| U19 | F | Run-off, 80 against 80 | Nobody elected |
| U20 | F | "Present" round, present count not entered | Nobody elected, flagged as missing |
| U21 | N | Bureau, 5 candidates above 86 | The 5 are kept |
| U22 | A | Bureau, 7 candidates above 86 | Only the first 5 are kept |
| U23 | A | Bureau, 4 above 86 | 4 kept, 1 seat open |
| U24 | A | Bureau, 5th and 6th equal, both above 86 | Draw between the two for the last seat |
| U25 | F | Bureau, 5th and 6th equal but below 86 | No draw: both not kept, 1 seat open |
| U26 | F | Bureau, nobody reaches 86 | Nobody kept, 5 seats open |
| U27 | N | Bureau re-vote, 2 seats, majority of those present | The first 2 above 81 are kept |
| U28 | N | Order of the results table | Highest votes first |
| U29 | F | Vote for an unknown name | Shown as non-member, never kept |
| U30 | N | Totals | Valid + cancelled = total |
| U32 | N | Papers recorded as cancelled, plus 2 added by the supervisor | No vote given; cancelled = team + supervisor; total includes them |
| U31 | A | Name waiting for the supervisor with the most votes | Flagged as waiting, not kept |

## 3. Automated cases: screen logic and server

### Screen logic

| ID | Type | Case | Expected |
|---|---|---|---|
| F01 | N | Type the first letters of a name | The name is found |
| F02 | A | Type without hamza | Still found |
| F03 | A | Type the family name first; type letters from the middle of a word | Found; not found |
| F04 | F | Empty text, unknown name | No result |
| F05 | N | Many matches | Limited to the requested number |
| F06 | A | Round with no paper | "لم يتم إدخال أي ورقة بعد" |
| F07 | N | President elected | "المنتخب: …", no run-off mentioned |
| F08 | A | No absolute majority | Majority not reached + "يعاد التصويت بين الأول والثاني" with both names |
| F09 | A | Draw for 2nd place | "تعادل في المراتب الأولى بين" with the three names |
| F10 | N | Run-off won | "المنتخب: …" |
| F11 | F | Run-off 80/80 | "تعادل (80 صوتا) بين" with both names |
| F12 | A | Nomination with a draw for 5th | Retained names + draw with the two names |
| F13 | A | Bureau with a seat left | "مقاعد لم تحسم بعد: 1" |
| F14 | F | Present count missing | Warning, no winner shown |
| F15 | N | Next round after nomination | President vote with the 5 names |
| F16 | A | Next round after nomination with draw | The tied names are included |
| F17 | N | Next round after president elected | None |
| F18 | A | Next round after no majority | Run-off with the first two |
| F19 | A | Next round after draw for 2nd | All three names proposed |
| F20 | N | Next round after complete bureau | None |
| F21 | A | Next round after bureau with 2 seats left | Re-vote, 2 seats, candidates not yet kept |
| F22 | A | Next round after bureau draw | Re-vote between the tied candidates only |
| F23 | F | Next round after a tied run-off | None: the supervisor decides |
| F25 | N | Bureau re-vote with 1 seat decided | "المحتفظ به: …", never "المنتخب" |
| F26 | F | Elements marked hidden (supervisor tabs before login) | Stay hidden |
| F27 | N/A | Who may be a candidate: president, run-off, bureau, no earlier round | Retained + tied of the nomination; president candidates; anyone; anyone |
| F24 | F | Script of each page | Valid JavaScript (catches a broken page before it is opened) |

### Server

| ID | Type | Case | Expected |
|---|---|---|---|
| A01 | F | Use before first setup | Nothing accessible |
| A02 | F | Setup with codes that are too short | Refused |
| A03 | N | Setup, then a second setup attempt | First accepted, second refused |
| A04 | N/F | Supervisor login, right and wrong code | Accepted / refused |
| A05 | N/F | Team login with a code created by the supervisor; wrong, empty or supervisor code | Accepted / refused; refused logins create no team |
| A05b | N/F | Second device with a code in use; code typed with a space and Arabic digits; a browser claims another team's name; log out | Refused, first device keeps working; accepted; the claim is ignored; team free again |
| A05c | N/F | New code for a team; delete a team | Old code and old login stop working; other teams not affected |
| A06 | F | A team calls each of the 15 supervisor actions | All refused |
| A07 | F | Entry without login, or with a false login | Refused |
| A07b | F | Tokens such as `__proto__`, `constructor`, `toString` | Refused on every entry action |
| A08 | F | Counts of 0, negative, decimal, text | Refused |
| A09 | N | Counts 170 and 160 | Majorities 86 and 81 |
| A10 | A | Change the supervisor code | Old code refused, new accepted, teams stay logged in |
| A11 | N | Import a list with blank lines, extra columns, a duplicate | 8 members added; second import adds 0 |
| A12 | A | Add a name already present with another spelling | Not added twice |
| A13 | F | Empty name, name over 80 characters | Refused |
| A14 | A | A team adds a name and claims it is a member | Added as non-member |
| A14b | A | A name added by a team; a name added by the supervisor | First waits for a decision, with the team and the number of papers; second does not |
| A15 | N/F | Correct a name; rename to an existing name | Accepted / refused |
| A16 | N | Delete a name never used | Deleted |
| A17 | F | 9 invalid round configurations | All refused |
| A18 | N | New round | Closed to entry, hidden from teams |
| A19 | N | Open the round | Teams see it with its rules |
| A20 | F | Paper with 2 names, 6 names, unknown name, nothing, a duplicate leaving only 2 names, more than 20 entries | All refused; the duplicate case says how many names remain |
| A20b | A | Name written twice or three times with 3 other names; 6 lines with one duplicate; two names each twice; unknown name twice | Name not counted, paper counts for the others; accepted with 4; refused; refused |
| A21 | N | Papers with 3, 4, 5 names from two teams | Counted, per-team counts correct |
| A22 | N | Each team's own counter and recent papers | Only its own |
| A22b | A | The supervisor creates a team in the middle of an open round | It joins as the next team; results and other teams' counts unchanged; its papers are its own |
| A22c | F | Delete a team that entered papers | Refused |
| A23 | A | Non-member with votes, then added as member by the supervisor | Left out, then counted with the same votes, no duplicate |
| A23b | A | Team name with 2 votes: waiting, rejected, written again, accepted | Not counted; rejected not counted and not asked again; accepted counted with its 2 votes |
| A24 | A | Remove and give back membership | Result follows each change |
| A25 | F | Delete a name that received votes | Refused |
| A26 | F | Reconfigure a round that has papers | Refused |
| A27 | N/F | A team asks to delete its own paper; another team's paper; the supervisor accepts | Request recorded, paper still counted / refused / paper removed |
| A27b | A/F | The supervisor rejects a request; the team asks again; a team tries to decide | Paper stays counted, team sees the refusal / refused / refused |
| A28 | A | Merge two spellings, including papers with both | Votes moved; on a paper with both the name is not counted; a paper left under the minimum becomes a cancelled paper of its team, and is reported |
| A29 | N/F | Supervisor adds cancelled papers: 2; -1; 2.5 | Added to the total / refused |
| A29b | F | A team tries to record a cancelled paper, with or without names, or without login | Refused; results unchanged |
| A30 | F | Enter a paper, record a cancelled paper, or delete a paper after closing | Refused |
| A31 | N | Publish and hide a nomination result | Hidden until published; only retained names shown |
| A32a | F/A | President round with a name not retained; with tied names; edited to a name not retained; bureau with any members | Refused with the nomination's title; accepted; refused; accepted |
| A32b | F/N | Run-off with a name that was not a president candidate; with two candidates | Refused; accepted |
| A32 | F/A | President vote: 2 names, only a non-candidate, blank, the same name twice; a candidate + a non-candidate | Refused; the last is counted for the candidate |
| A32b | A | Bureau: 4 candidates + 1 outside name; outside name sent by id; 5 + 1 outside; 6 candidates; duplicate + outside; only outside names; invalid outside counts | Counted for the 4; same; accepted; refused; counts for what remains; refused; refused |
| A33 | N | Reconfigure a round with no paper | Accepted |
| A34 | N/F | President with 85 votes, then 86 | Not elected, then elected |
| A35 | F | Delete a name that is a candidate | Refused |
| A36 | N | Publish the president vote | All candidates shown, winner marked |
| A36b | A | Close a round at 160 present, change to 120, reopen it | Closed round still judged on 160 (81); open round now on 120 (61) and entry continues; reopened round follows 120 |
| A37 | F | Broken request, unknown address, malformed address | Clean error; server keeps running |
| A38 | N/F | Load the pages; ask for files outside the public folder | Served / not served |
| A39 | N | Codes in the data sent to browsers | Supervisor code never present; team codes sent to the supervisor only |
| A40 | N | Stop and restart the server | Same data, logins kept, backup file created |
| A41 | N | Delete a round | Its papers and public result are gone, other rounds intact |
| A42 | A | Data saved by the earlier version (one shared team code, closed rounds without frozen counts) | Loads; each team keeps its papers and gets its own code, saved across restarts; the shared code and old team logins stop working; old closed rounds are frozen with the counts in force |
| A42b | A | Saved data with two logins for one team | Only the latest stays |
| A43 | F/A | 5 wrong team codes from one device | Even the right code waits; supervisor and other devices are not affected; allowed again after the wait; recorded in the history |
| A44 | A | Nomination paper with 2 members and a name that is then rejected; accepted later | Cancelled while rejected, no vote given; a new such paper is refused; counts again once accepted |
| A45 | A | Merge when a person is written three times on a paper | That person gets no vote; a paper left empty is cancelled |
| A46 | N/F | Deleted papers, requests, cancelled counts, settings, rounds, logins | All in the history with time and author, no code; teams cannot read it; kept after a restart |
| A47 | F | Open or reopen a round while another is open | Refused with the title of the open round |
| A48 | N/F | Bureau re-vote with one candidate; other rounds with one candidate | Accepted / refused |
| A49 | F | Delete a name that only appears as a duplicate on a paper | Refused |
| H01 | N | Start with a certificate | Pages answer in HTTPS |
| H02 | A | Open the `http://` address | Redirected to `https://` on the same port |
| H03 | N | Setup and login over HTTPS | Work |

## 4. Every button and key

All lines below are run by `e2e/ui-check.js`. They can also be done by hand; write OK or KO in the last column.

Do these in a browser on the event laptops. Write OK or KO in the last column. Preparation: start the app with an empty `data` folder, or use a copy of the project.

### Supervisor page (`/admin`)

| ID | Control | Action | Expected | Result |
|---|---|---|---|---|
| M01 | First setup form, «حفظ ودخول» | Enter a supervisor code | Enters the supervisor page | |
| M02 | Same form | Supervisor code of 3 characters | Red message, stays on the form | |
| M03 | «دخول» | Log out, log in with a wrong code, then the right one | Red message, then access | |
| M04 | «خروج» | Click | Back to the login form | |
| M05 | «صفحة النتائج العامة» | Click | Public page opens in a new tab | |
| M06 | Tabs «الجولات والنتائج», «لائحة الأعضاء», «فرق الفرز», «الإعدادات» | Click each | The matching screen shows; the tab is highlighted | |
| M07 | Settings, first «حفظ» | Enter 170 and 160 | Message «تم الحفظ»; line shows 86 and 81 | |
| M07b | «عدد الحاضرين الآن», «تحديث» (rounds tab) | Change the number while a round is open and another is closed | Open round's majority changes; the closed round's line still shows the count it was closed with | |
| M07c | «إعادة فتح الإدخال» after changing the count | Reopen the closed round | Asked to confirm it will use the current count | |
| M08 | Settings, first «حفظ» | Enter 0 as expected count | Refused with a red message | |
| M09 | «＋ إنشاء فريق» (teams tab) | Click twice | Two teams appear, each with its own 5-digit code | |
| M10 | Settings, new supervisor code left empty | Save | Supervisor code unchanged | |
| M11 | «إضافة اللائحة» | Paste 10 names, one per line | Message with the number added; list shows 10 | |
| M12 | «إضافة اللائحة» | Paste the same list again | 0 added | |
| M13 | «إضافة كعضو» | Type a new name | Appears in the list as «عضو» | |
| M14 | Search field | Type the first letters of a name | List filters as you type | |
| M15 | «تصحيح» | Change a name | Name updated everywhere | |
| M16 | «تصحيح» | Rename to a name that exists | Refused | |
| M17 | «إزالة العضوية» | Confirm | Badge becomes «غير عضو» | |
| M18 | «اعتماده كعضو» | Click on a non-member | Badge becomes «عضو» | |
| M18b | Notice «أسماء جديدة أضافتها فرق الفرز» | A team adds an unknown name | Within 3 s, on any tab: red message, notice with the name, the team and the papers; tab title starts with «(1)» | |
| M18c | «مصادقة: عضو» / «رفض: ليس عضوا» / «نفس عضو موجود» | Click each on a waiting name | Counted / stays not counted after confirmation / merge window opens; the name leaves the notice | |
| M19 | «حذف» (name) | On a name never used | Removed after confirmation | |
| M20 | «حذف» (name) | Look at a name that has votes | No delete button on that line | |
| M21 | «دمج», then «دمج» | Choose the correct name | Votes moved; old name gone | |
| M22 | «دمج», then «دمج» | Click without choosing a name | Red message | |
| M23 | «دمج», then «إلغاء» | Click | Window closes, nothing changed | |
| M24 | «＋ جولة جديدة» | Click | Window opens, first round type selected | |
| M25 | Round type list | Choose each of the 5 types | Title, numbers and win rule change to match | |
| M26 | Candidate field | Type letters, press Enter | Name added as a chip; non-members are not offered | |
| M27 | «×» on a candidate | Click | Candidate removed | |
| M28 | «حفظ» (round) | Candidate round with 1 candidate | Refused with a red message | |
| M29 | «حفظ» (round) | Valid round | Round card appears, state «لم تفتح بعد» | |
| M30 | «إلغاء» (round) | Click | Window closes, no round created | |
| M31 | «تعديل» | On a round with no paper, change the title | Title updated | |
| M32 | «تعديل» | Look at a round that has papers | Button is not shown | |
| M33 | «فتح الإدخال» | Click | State «مفتوحة للإدخال»; round appears on `/team` | |
| M34 | «إغلاق الإدخال» | Click | State «مغلقة»; round disappears from `/team` | |
| M34b | «إغلاق الإدخال» while a team is entering a paper | Select a name on the team page, then close the round | The team gets «الورقة الجارية لم تحفظ» | |
| M35 | «إعادة فتح الإدخال» | Click on a closed round | Open again | |
| M36 | «أوراق ملغاة يضيفها المشرف», «حفظ» | Enter 3 | «مجموع الملغاة» shows 3; total increases by 3 | |
| M37 | «نشر النتيجة للعموم» | Click | Badge «منشورة للعموم»; result visible on `/` | |
| M38 | «إخفاء عن العموم» | Click | Result disappears from `/` | |
| M39 | «الأوراق» | Click | List of papers with number and team | |
| M40 | «حذف» (paper, in that list) | Confirm | Paper removed, totals drop | |
| M41 | «إغلاق» (papers list) | Click | Window closes | |
| M42 | «حذف» (round) | Cancel the confirmation, then confirm | Nothing; then round and its papers removed | |
| M43 | «إنشاء الجولة التالية» | After a nomination with papers; type a name that was not retained | Window opens with the retained candidates filled in, label «من المحتفظ بهم في …»; the name is not offered | |
| M44 | «طباعة النتائج» | Click | Print preview shows results without buttons | |
| M45 | Live update | Leave the rounds tab open while a team enters papers | Totals change within 3 seconds, without reloading | |
| M46 | Warning | Enter more papers than the present count | Orange warning on the round | |
| M63 | «رمز جديد» (teams tab) | Confirm on a logged-in team | The team is logged out; old code refused; new code works | |
| M64 | «حذف» (teams tab) | On a team without papers; look at a team with papers | Removed after confirmation; no delete button | |
| M65 | Notice «طلبات حذف أوراق», «قبول الحذف» / «رفض» | A team asks to delete a paper | Within 3 s, on any tab: red message and notice with the paper, team and round. Accept removes it; reject keeps it counted | |
| M66 | Tab «السجل» | Open it after some changes | Changes listed, newest first, with time and author | |

### Counting team page (`/team`)

| ID | Control | Action | Expected | Result |
|---|---|---|---|---|
| M47 | «دخول» | Wrong code, then the team's code | Red message, then access; the team's name appears in the header | |
| M47b | One code per team | Log in with a second team's code; log out and in again with the first | Each code opens its own team | |
| M47d | One device per team | Enter a code already open on another device | Red message «مفتوح على جهاز آخر»; stays on the login form | |
| M47c | Team list for the supervisor | Look at the top of the rounds tab on `/admin` | Each team with its number of papers | |
| M48 | No round open | Log in before any round is open | Message to wait; the page updates by itself when a round opens | |
| M49 | «فتح الإدخال» with a round already open | Try to open a second round, close the first, open it again | Red message naming the open round; opens once the first is closed; teams move to it | |
| M50 | Name field | Type 3 letters | List of matching names; first one highlighted | |
| M51 | Arrow keys, `Enter` | Move down, press Enter | The highlighted name is added as a numbered chip | |
| M52 | `Escape` | Type letters, press Escape | Field cleared | |
| M53 | `Backspace` on empty field | Press | Last chip removed | |
| M54 | «×» on a chip | Click | That name removed | |
| M55 | «➕ إضافة … كاسم جديد» | Type an unknown name, choose this line, confirm | Chip added in orange with «غير عضو» | |
| M56 | «حفظ الورقة» with 2 names | Look at the button; press Enter on the empty field | Button greyed out; red message to set the paper aside; nothing recorded | |
| M56b | Same name twice | Pick a name already on the paper | Chip struck through in red «مكرر: لا يحتسب»; counter drops by one; × on it cancels the mark |
| M56c | «… مكرر» buttons | Candidate round: select a candidate, click its «مكرر» button | Candidate struck through, not counted; with 1 name allowed, the paper can no longer be saved |
| M56d | «＋ اسم خارج اللائحة (0)» and «−» | Candidate round: press `0` or click, then «−» | Counter «لا تحتسب: 1», hint updated; back to 0. Saved paper shows «أسماء خارج اللائحة لا تحتسب» | |
| M57 | 6th name | Try to add a 6th name | Refused with a red message | |
| M58 | `Enter` on empty field, or «حفظ الورقة» | With 3 names | «تم حفظ الورقة ✓»; field empty and ready; counter +1 | |
| M58b | No cancel button | Look at the entry area | The team page has no button to record a cancelled paper | |
| M59 | «مسح» | With names chosen | All chips removed | |
| M60 | Candidate buttons and number keys | Candidate round: press `1`, then `2` (1 name allowed) | Selection moves from 1 to 2; Arabic digits work too | |
| M61 | `Enter` (candidate round) | With a candidate selected; with none | Saved; refused | |
| M62 | «طلب حذف» (recent paper) and «خروج» | Ask to delete the last paper; log out | Badge «في انتظار موافقة المشرف»; counter -1 once accepted; back to login | |

### Public page (`/`)

Checked inside the scenarios below: nothing shown before publishing, result appears within 4 seconds after publishing, and the «فرق الفرز» and «المشرف» links open the two other pages.

## 5. Manual scenarios: a complete election

Use a small assembly so the numbers can be entered quickly: **10 members expected, 9 present**. Absolute majority = 6, majority of those present = 5. Members: A, B, C, D, E, F, G, H (use 8 real names).

| ID | Type | Steps | Expected |
|---|---|---|---|
| S1 | Nominal | 1. Nomination: enter 9 papers so that A, B, C, D, E clearly lead. 2. Close, create the next round with the button. 3. President vote: A gets 6, B gets 3. 4. Publish. | Step 1: 5 retained names. Step 2: the 5 names are prefilled. Step 3: «المنتخب: A», majority shown as 6. Step 4: visible on `/`. |
| S2 | Alternative: run-off | President vote: A 4, B 3, C 2. Create the next round. Run-off: A 5, B 4. | «لم يحصل أي مرشح على الأغلبية» and «يعاد التصويت بين الأول والثاني: A ، B». Run-off prefilled with A and B. «المنتخب: A» with majority 5. |
| S3 | Alternative: draw for 5th place | Nomination where E and F have the same votes in 5th place. | Draw announced with E and F. Next round proposes 6 names; the supervisor removes one or keeps both. |
| S4 | Alternative: draw for 2nd place | President vote: A 4, B 2, C 2, D 1. | «تعادل في المراتب الأولى بين» A, B, C. Next round proposes the three. |
| S5 | Failing: tied run-off | Run-off: A 4, B 4, 1 cancelled paper. | «تعادل (4 صوتا) بين: A ، B». Nobody elected. No next round proposed. |
| S6 | Alternative: non-member | Nomination: a team adds «Z», who gets enough votes to be in the first five. Then the supervisor adds Z as a member. | Z shown as «غير عضو» and not retained. After the supervisor's action, Z is retained with the same votes and the 6th name drops out. |
| S7 | Nominal: bureau | Bureau vote on 8 candidates, 9 papers of 5 names; 5 candidates get 6 or more. | The 5 are «محتفظ به», no seat left, no next round. |
| S8 | Alternative: bureau incomplete | Bureau vote where only 3 candidates reach 6. Create the next round. Re-vote: 2 candidates reach 5. | «مقاعد لم تحسم بعد: 2». Re-vote prefilled with the other 5 candidates and 2 seats. Then 2 more kept. |
| S10 | Alternative: name written twice | Nomination: enter a paper A, A, B, C, D, then a paper A, A, B, C. | First paper counts for B, C, D only. Second refused (2 names left): set aside for the supervisor. |
| S11 | Alternative: name outside the list | Bureau vote: paper with 4 candidates and a name not on the president's list; paper with only that name. | First counts for the 4. Second refused: set aside for the supervisor. |
| S9 | Failing: papers set aside | Nomination: team 1 tries a paper with 2 names and is told to set it aside; team 2 sets aside a blank paper. The supervisor examines both and enters 2 cancelled papers. | Supervisor page: «مجموع الملغاة: 2»; the total includes them; no candidate gained a vote. |

## 6. Manual cases: event conditions

| ID | Case | Steps | Expected | Result |
|---|---|---|---|---|
| E1 | Start and stop | Run `./start.sh`, then `Ctrl+C` | Port opened, then «Firewall: port 3000 closed.» | |
| E2 | Other laptops | Open the `https://` address from another laptop on the same Wi-Fi | Page loads after accepting the warning | |
| E3 | Phone | Same from a phone, mobile data off | Page loads | |
| E4 | Five teams together | 5 laptops enter 10 papers each in the same round | Supervisor total = 50; per-team counts = 10 each | |
| E5 | Restart during the count | Stop the app in the middle of a round, start it again | All papers still there; teams continue without logging in again | |
| E6 | Wi-Fi cut on one team | Turn off Wi-Fi on a team laptop, press save, turn it back on | Red error, paper not counted; saving again works and the paper is counted once | |
| E7 | New network | Change Wi-Fi network, run `./make-cert.sh`, restart | The new address works in HTTPS | |
| E8 | Record after the event | Copy `data/vote.json` to a USB key | File copied; it contains every paper | |
| E9 | App name | On each event device, open `https://voteattawhid.local:3000` | The app opens; on a device that cannot find the name, the IP address still works | |

## 7. Known limits

- **Papers are not numbered**, so the app cannot detect the same paper entered twice. The only guard is the warning when the total exceeds the present count (M46). Each team should move entered papers to a separate box.
- **A tied run-off and a tied draw re-vote have no automatic rule.** The app announces the draw with the names; the committee decides.
- **The `https://` warning** appears on each device until `certs/ca.pem` is imported in its browser.
- **The wrong-code wait is per network address.** Someone who keeps changing address on the Wi-Fi can try more codes. Having every team log in before the first round closes this, because a code already in use cannot be opened elsewhere.
- **A team stays tied to its device until it logs out.** If the device fails, or its browser data is cleared, the supervisor presses «رمز جديد» so the team can log in from another device.
- **Screens update every 3 seconds** (teams) and 3 seconds (supervisor). A team can still see a round for up to 3 seconds after it is closed; it is then told if a paper in progress was not saved.
