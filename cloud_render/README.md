# SHG Cloud Render Farm

Cloud-native video rendering. No Mac required. Runs on GitHub Actions, stores in Cloudflare R2.

## Pipeline
ElevenLabs (voice) → Pexels (B-roll stills) → FFmpeg (compose) → R2 (host) → Postiz (post, Phase 2).

## Trigger one render
```
gh workflow run "SHG Render Farm" --ref main -f script=shg_001_permission_slip
```

## Trigger all 15
```
gh workflow run "SHG Render Farm" --ref main -f script=all
```

## Output
Each video is uploaded to R2 at `https://pub-404744d3257c4094982b374d0827c547.r2.dev/<script_id>.mp4`.

## Cost per run
- ElevenLabs: ~$0.06 per voice (160 chars × $0.0004/char)
- Pexels: free
- GitHub Actions: free for public repos, ~6 minutes per video on default runner
- R2: free up to 10GB, $0.015/GB after; egress free up to 1M reqs/mo
- Total: <$1 to render all 15

## Required GitHub secrets
- `ELEVENLABS_API_KEY`
- `PEXELS_API_KEY`
- `CLOUDFLARE_API_TOKEN` (for wrangler R2 upload)
- `CLOUDFLARE_ACCOUNT_ID`
