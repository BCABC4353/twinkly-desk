# Twinkly Desk

Desktop controller for Twinkly light sets. Finds every set on the local network, reads the bulb map the Twinkly app created, and drives all sets as one surface: live patterns, GIFs and video, scrolling text, presets, a schedule, and movies stored on the strings themselves.

## Run from source

```
npm install
npm start
```

## Build the installer and portable exe

```
npm run package:win
```

Output lands in `build-output`.

## Releases

Run the **Build and Release** workflow from the Actions tab and pick patch, minor or major. It bumps the version, tags it, builds on a Windows runner and publishes a GitHub Release with `Twinkly-Desk-<version>-Windows-Setup.exe` and `Twinkly-Desk-<version>-Windows-Portable.exe`. Pushing a change to `RELEASE_REQUEST` on `main` does the same, using the bump named on its first line.
