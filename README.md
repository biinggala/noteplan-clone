This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Mobile PWA

The app ships as an installable Progressive Web App with a dedicated phone
layout modelled on NotePlan mobile (month calendar on top, the daily note
below, a slide-in folder drawer, and a Timeline bottom sheet).

- **Install:** open the deployed site on a phone → *Add to Home Screen*
  (a custom install prompt also appears on supported browsers). It then runs
  full-screen, standalone, with offline app-shell caching.
- **Implementation:** `app/manifest.ts` (web manifest), `public/sw.js`
  (service worker), `components/pwa/` (registration + install prompt), and
  `components/mobile/` (the responsive phone shell). The layout switches
  automatically below 768px via `lib/hooks/useIsMobile.ts`.
- **Icons:** generated procedurally — regenerate with `node scripts/gen-icons.mjs`.

### Deploying to get a mobile login link

The app needs an **HTTPS** URL and your Supabase backend, so it can't run from
a plain local IP — Google OAuth refuses to redirect to non-HTTPS/private hosts,
which is why phone login fails over `http://192.168.x.x`. Two ways to get a
working link:

**A. Vercel (permanent link — recommended, ~2 min)**

1. Import the repo at [vercel.com/new](https://vercel.com/new) (pick this branch).
2. Add env vars `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   (the same values the desktop app uses).
3. Deploy → you get `https://<project>.vercel.app`.
4. **Required for login:** in the Supabase dashboard → *Authentication → URL
   Configuration → Redirect URLs*, add `https://<project>.vercel.app/**`.
   Without this the Google callback is rejected after sign-in.
5. Open the URL on your phone, sign in with Google, and *Add to Home Screen*
   to run it as an installed PWA.

**B. Quick temporary link (no deploy)**

1. Run `npm run dev` on your computer.
2. Expose it: `npx cloudflared tunnel --url http://localhost:3000`
   (or `ngrok http 3000`) → you get a temporary `https://…` URL.
3. Add that URL's `/auth/callback` (or `…/**`) to the Supabase Redirect URLs
   as in step A.4, then open it on your phone. The link disappears when the
   tunnel stops.

> Keep Next.js in its default server-rendered mode for this web target. The
> desktop bundle (Electron/Tauri) is a separate build and doesn't affect it.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
