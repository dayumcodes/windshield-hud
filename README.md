# Windshield HUD

A free heads-up display web app for your car. It shows speed, compass heading, speed limits and turn-by-turn directions on your phone, mirrored so you can read them reflected in the windshield at night.

Live: https://windshield-hud.vercel.app

## Features

- GPS speed (km/h or mph)
- Compass heading and clock
- Mirror mode for windshield reflection
- Destination search and turn-by-turn directions with a route-line diagram and ETA
- Speed-limit display for the current road (best effort)
- 6 color themes, 3 layouts, adjustable size
- Screen wake lock while driving
- Demo mode with simulated drive: open the site with `?demo=1`

Everything runs in the browser. No account, no tracking - position data is only sent to OpenStreetMap services to look up speed limits and plan routes.

## Services used

- OpenStreetMap data (c) OpenStreetMap contributors
- Routing: OSRM demo server (fair use)
- Search: Photon by Komoot (fair use)
- Speed limits: Overpass API (fair use)

## Development

Static site, no build step. `index.html`, `style.css`, `app.js` served as-is (see `vercel.json`). Deploy by pushing the files to any static host.
