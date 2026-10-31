# Patata!

A silly party game where you guess numbers: how tall is the Eiffel Tower, how many hearts does an octopus have, what year did the Titanic sink. Every wrong guess gets a "More!" or "Less!" hint, and you have 45 seconds to land on the answer.

## Modes

- **Party mode** (`/host` and `/`): one screen, like a TV, a laptop or a shared video call, shows the room code and the questions. Everyone joins from their phone at the main page with the 4-letter code. Hints are private to each phone. The host screen shows who has already got it, the answer, a fun fact and the scores.
- **Solo** (`/solo`): play on your own.

Players pick an icon when they join. The look is a light retro TV game show (cream studio, marquee bulbs, chunky Bungee lettering).

## Rules

- 10 random questions from the topics the host picks (Geography, Entertainment, History, Art & Literature, Sports & Leisure, Nature, Animals, Human body, Space, Vehicles). The first five follow Trivial Pursuit, with questions about Spanish culture.
- Land within 2% of the answer to score 100 points, plus 3 for every second left. For year questions, only the exact year counts.
- If time runs out, your closest guess still scores if it was within 50% (within 20 years for years).

## Run it on your computer

Requires Node 18 or newer. There's nothing to install: the game uses no outside packages.

```
npm start
```

Then open http://localhost:3000/host for the big screen, and http://localhost:3000 on the phones. Phones need to be on the same wifi and use your computer's local IP address instead of localhost.

## Deploy

Any host that runs a Node app works (Railway, Render, Fly.io). The start command is `npm start`, and the app reads the port from the `PORT` environment variable.

Rooms live in the server's memory, so a restart ends any games in progress. That's fine for parties; saved leaderboards would need a database later.

## Files

- `server.js`: the game server (rooms, timer, scoring, live updates to every screen)
- `questions.js`: the question bank. `t` is the topic, `a` is the answer, and `unit: "year"` means only the exact year counts.
- `public/host.html`: the big screen
- `public/index.html`: the phone page (join and play)
- `public/solo.html`: solo game
- `public/style.css`: shared look
