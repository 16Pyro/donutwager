# DonutWager 🍩

The DonutSMP community casino. Seven games, provably fair, all server-sided.
Guests can play instantly (a Guest_xxxx account is created on their first bet)
and everyone starts with 100B coins. Bets accept K/M/B shorthand like `2.5b`.

## Run it

```
npm install
npm start
```

Site comes up on http://localhost:3000 (set `PORT` to change it).

## Hosting notes

- Set `NODE_ENV=production` in prod — this flips the session cookie to `Secure`,
  so it **must** sit behind HTTPS (a reverse proxy like Caddy/nginx, or a host
  that terminates TLS). `trust proxy` is already enabled.
- All state lives in `data/` (SQLite DB + session secret). Back that folder up;
  don't commit it.
- Single process only — the SQLite writes assume one node instance. Plenty for
  a community site.

## Security model

- Every outcome (dice roll, mine layout, tower bombs, card shoe) is generated
  and settled **server-side**. The browser only sends "bet X on Y" and renders
  the answer, so editing client JS can't win you anything.
- Balances are integers (cents) in SQLite; debits use a conditional UPDATE so a
  bet can never overdraw, even with racing requests.
- Passwords are bcrypt-hashed, sessions are httpOnly cookies, and bets are
  throttled per user.

## Provably fair

Each user has a hashed server seed + client seed + nonce. Results come from
`HMAC-SHA256(serverSeed, clientSeed:nonce:cursor)`. Rotating your seed (on the
Fairness page) reveals the old server seed so past bets can be re-verified.

## Games & edge

| Game      | House edge |
|-----------|-----------|
| Dice      | 1% |
| Coinflip  | 1% (pays 1.98×) |
| Mines     | 1% |
| Towers    | 1% per floor |
| Blackjack | standard rules, 3:2 blackjack, dealer stands on 17 |
