# DonutWager - Setup & Deployment Guide

## Architecture Overview
DonutWager is a full-stack gambling platform designed for Minecraft SMPs.
- **Frontend:** Next.js 14, TailwindCSS
- **Backend API:** Next.js API Routes (Serverless)
- **Database:** PostgreSQL (Prisma ORM)
- **Minecraft Plugin:** Paper/Spigot 1.21 Java plugin.

## 1. Web Platform Setup
1. Ensure Node.js (v18+) is installed.
2. Navigate to `donutwager-web`.
3. Run `npm install` to install dependencies.
4. Set up your PostgreSQL database (e.g., local Postgres or Supabase).
5. Add a `.env` file in `donutwager-web`:
   ```
   DATABASE_URL="postgresql://user:password@localhost:5432/donutwager?schema=public"
   ```
6. Run `npx prisma db push` to push the schema to the database.
7. Run `npm run dev` to start the frontend on `http://localhost:3000`.

## 2. Minecraft Plugin Setup
1. Ensure you have Java 21 and Maven installed.
2. Navigate to `donutwager-plugin`.
3. Run `mvn clean package`.
4. Grab the shaded JAR from `target/donutwager-plugin-1.0-SNAPSHOT.jar`.
5. Drop it into your Paper 1.21 server's `plugins/` folder.
6. Start the server, then edit `plugins/DonutWager/config.yml` to point to the **same PostgreSQL database** as the web app.
7. Restart the server.

## 3. Security Best Practices (CRITICAL)
Since you are handling real money and balances, you must implement the following:

- **Database Security:** Do not expose the PostgreSQL port to the public internet. Use a VPC or allowlist IPs (the web server and the Minecraft server IPs).
- **Transactions:** Use Prisma `$transaction` API when processing bets or payments to ensure atomic operations (no race conditions where a user can bet the same $10 twice).
- **Payment Integration:** 
  - For **Stripe**, use Stripe Checkout with webhooks. Validate the webhook signature before crediting the account in the DB.
  - For **Crypto (Solana/USDT)**, generate a unique deposit address per user. Run a background cron job/worker that checks the blockchain for incoming transactions to those addresses, requiring a specific number of confirmations before crediting.
- **Withdrawal Queue:** ALL withdrawals should be marked as `PENDING` in the database. Build an Admin dashboard where staff must manually review and approve the withdrawal before processing the payment out.
- **Minecraft Authentication:** Ensure your SMP runs in `online-mode=true` so players can't spoof UUIDs. The web app should ideally authenticate users by having them link their Discord, or run an in-game command `/donut link` which generates a temporary token they enter on the website to bind their UUID to their web account.

## Legal Disclaimer
*Minecraft EULA strictly prohibits the use of real money for gambling on Minecraft servers. You must ensure you are legally compliant with your local jurisdiction and Mojang's EULA.*
