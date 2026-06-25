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

### Deploying the PWA (to get a public link)

A PWA must be served over HTTPS. The fastest path is Vercel:

1. Push this branch and import the repo at [vercel.com/new](https://vercel.com/new).
2. Set the env vars `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` (same values the desktop app uses).
3. Deploy — the resulting `https://…vercel.app` URL is your installable mobile link.

> Keep Next.js in its default server-rendered mode for this web/PWA target.
> The desktop bundle (Electron/Tauri) is a separate build and does not affect
> the PWA deployment.

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
