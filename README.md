# ExF Event Manager + Partner Interest form (Railway)

One server that runs:

- **The Event Manager** at `/` (sign-in required). Same app as in Claude: scan cards, meetings, directory, sharing, follow-ups, exports.
- **The Partner Interest form** at `/partner`, and short pre-filled links at `/p/<code>`. Public, no sign-in.
- **Email to you** (`NOTIFY_EMAIL`) on every submission, with the form data, the business card photo and a link to the record.
- **Admin page** at `/admin` (password): search, open and export (CSV) every partner submission.
- When a partner submits the form with the same email as a contact in the Event Manager, that contact is automatically marked **Partner interest form returned**.

## Files

```
package.json, package-lock.json   dependencies (express, pg)
server.js                         the server
public/app.html                   the Event Manager
public/partner.html               the Partner Interest form
public/shim.js                    connects the app to the server (database, photos, card reading, downloads)
.env.example                      the variables to set in Railway
```

## 1. GitHub

1. github.com > **New repository**. Name `exf-event-manager`, **Private**. Create it.
2. On the new repo page click **uploading an existing file**. Drag in everything from this folder (the files above and the `public` folder). Do **not** upload `node_modules` or any `.env` file. Click **Commit changes**.

Command line instead:

```
cd exf-event-manager
git init && git add . && git commit -m "ExF Event Manager"
git branch -M main
git remote add origin https://github.com/YOUR-USER/exf-event-manager.git
git push -u origin main
```

If the repo already has the old single HTML file in it, delete that file first. Railway builds from `package.json`, which is what failed before.

## 2. Railway

1. railway.com > log in with GitHub > **New Project** > **Deploy from GitHub repo** > pick `exf-event-manager`.
2. In the same project: **New** (top right) > **Database** > **Add PostgreSQL**.
3. Click your **server service** (the GitHub one) > **Variables** > add these:

| Variable | Value |
|---|---|
| `DATABASE_URL` | click **Add Reference** and choose the Postgres service's `DATABASE_URL` (it looks like `${{Postgres.DATABASE_URL}}`) |
| `SESSION_SECRET` | any long random text, 40 or more characters |
| `ACCESS_CODE` | the team code colleagues type to sign in (choose one) |
| `ADMIN_EMAILS` | `robb@qurogroup.com` (comma separated; these people are "owner" in the app) |
| `ADMIN_PASSWORD` | a password for `/admin` |
| `NOTIFY_EMAIL` | `rdoduck@exfreight.com` |
| `RESEND_API_KEY` | from resend.com (step 3) |
| `MAIL_FROM` | `ExFreight Partners <onboarding@resend.dev>` for testing; change after you verify your domain |
| `ANTHROPIC_API_KEY` | from console.anthropic.com > API keys (step 4) |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` (change if that name is retired) |
| `BASE_URL` | your public address from step 5, no trailing slash |

4. Settings > **Networking** > **Generate Domain**. Copy the address (for example `https://exf-event-manager.up.railway.app`) into `BASE_URL`, then it redeploys.

## 3. Email (Resend)

1. resend.com > create an account > **API Keys** > create a key > paste into `RESEND_API_KEY`.
2. Testing: with `onboarding@resend.dev` Resend only delivers to the email you signed up with. Sign up with the address in `NOTIFY_EMAIL`, or just test with that.
3. Live: Resend > **Domains** > add `exfreight.com`. Ask IT to add the DNS records it shows. Then set `MAIL_FROM` to something like `ExFreight Partners <partners@exfreight.com>`.

## 4. Card reading (Anthropic API)

Reading business cards and importing schedules uses the Anthropic API. console.anthropic.com > create an account and add a small credit balance > **API Keys** > create a key > paste into `ANTHROPIC_API_KEY`. A card read costs a fraction of a cent. Without the key everything else works but scanning shows an error.

## 5. First run

1. Open the Railway address. Sign in with your name, work email and `ACCESS_CODE`. Your email in `ADMIN_EMAILS` makes you the owner.
2. Add an event (Event > create new), scan a card, open it, try **Send follow up**. The link in the message is a short `.../p/abc12345` link that opens the form already filled in.
3. Open that link in a private window (not signed in), submit the form. You should get the email, the contact shows **Form ✓**, and `/admin` lists the submission.
4. Send colleagues the app address and the access code. They sign in once and stay signed in for 90 days. After they open the app they appear in your Share list.

Install on a phone: open the address, then Share > **Add to Home Screen**.

## Notes

- **Your data is in Railway Postgres.** Railway keeps the volume, but set up its backups (Postgres service > Backups) and use **Export > Full backup (JSON)** now and then.
- **Visibility** works as before: records are yours, and colleagues see them when you share. This is enforced in the app screens, not in the server, so only give the access code to people you trust with all the data.
- **Access code** is shared. To cut off everyone, change `ACCESS_CODE` and `SESSION_SECRET` in Railway (everyone is signed out).
- **Hosting company data**: confirm with ExFreight IT that it is fine on your Railway account and in Resend.
- **Cost**: Railway about 5 dollars a month for the Hobby plan, plus a few cents of Anthropic usage.
- **Logs**: Railway > service > Deployments > View logs. A failed email shows a `Resend error` line there.
- **Custom address**: Settings > Networking > **Custom Domain**, then ask IT to add the DNS record Railway shows. Update `BASE_URL`.
