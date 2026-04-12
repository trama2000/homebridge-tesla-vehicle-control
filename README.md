# homebridge-tesla-vehicle-control

[![npm version](https://img.shields.io/npm/v/homebridge-tesla-vehicle-control)](https://www.npmjs.com/package/homebridge-tesla-vehicle-control)
[![license](https://img.shields.io/npm/l/homebridge-tesla-vehicle-control)](https://github.com/trama2000/homebridge-tesla-vehicle-control/blob/main/LICENSE)

**Homebridge plugin to control Tesla vehicles via Apple HomeKit** using the official [Tesla Fleet API](https://developer.tesla.com/docs/fleet-api) and [Vehicle Command Protocol](https://github.com/teslamotors/vehicle-command).

Control your Tesla directly from the Home app, Siri, or any HomeKit-compatible automation — lock/unlock doors, manage climate, toggle Sentry Mode, open trunk, control charging, and more.

---

## Features

| HomeKit Accessory | Service Type | What it does |
|---|---|---|
| 🔒 **Cerradura** | LockMechanism | Lock / Unlock doors |
| 🌡️ **Clima** | Thermostat | Climate ON/OFF + set temperature (15–28 °C, 0.5° steps) |
| 🛡️ **Sentry Mode** | Switch | Toggle Sentry Mode (auto-saves dashcam clip on activation) |
| 🚗 **Trunk** | Switch | Open/Close trunk |
| 📦 **Frunk** | Switch | Open front trunk |
| 🔌 **Charge Port** | Switch | Open/Close charge port |
| ⚡ **Charging** | Switch | Start/Stop charging |
| 💡 **Flash Light** | Switch | Flash headlights (momentary) |
| 📯 **Horn** | Switch | Honk horn (momentary) |
| 📹 **Dashcam** | Switch | Save dashcam clip (momentary) |
| 🪟 **Ventanas** | Switch | Vent / Close all windows |
| ❄️ **Defrost** | Switch | Max defrost ON/OFF |
| 🎡 **Volante Calef.** | Switch | Steering wheel heater ON/OFF |
| 🔋 **Límite Carga** | Lightbulb | Charge limit 50–100% (brightness slider) |
| 🔋 **Batería** | TemperatureSensor | Battery level (shown as °C = %) |
| 🔋 **Battery** | BatteryService | Battery level + low battery alert (<20%) |

### Additional Capabilities

- **Multi-region support** — EU, NA, and CN Tesla Fleet API endpoints
- **Automatic token refresh** — tokens are refreshed proactively 5 minutes before expiry
- **Auto-wake** — vehicle is automatically woken up before sending commands (up to 10 retries)
- **Vehicle Command Proxy** — supports `tesla-http-proxy` for 2024+ vehicles requiring signed commands
- **Periodic polling** — vehicle state is updated automatically (configurable interval, default 5 min)
- **Dashcam on Sentry** — optionally saves a dashcam clip every time Sentry Mode is activated
- **Retry with backoff** — automatic discovery retries with exponential backoff (up to 5 retries)
- **Cached accessories** — persists accessories across Homebridge restarts

---

## Requirements

- [Homebridge](https://homebridge.io/) >= 1.3.0
- Node.js >= 14.0
- A registered [Tesla Developer](https://developer.tesla.com/) application (Client ID + Secret)
- Tesla Fleet API access token + refresh token
- *(Optional)* [tesla-http-proxy](https://github.com/teslamotors/vehicle-command/tree/main/cmd/tesla-http-proxy) for Vehicle Command Protocol (required for 2024+ vehicles)

---

## Installation

### Via Homebridge UI (Recommended)

Search for `homebridge-tesla-vehicle-control` in the Homebridge plugins tab and click **Install**.

### Via CLI

```bash
npm install -g homebridge-tesla-vehicle-control
```

---

## Configuration

Add the `TeslaControl` platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "TeslaControl",
      "name": "TeslaControl",
      "accessToken": "YOUR_TESLA_ACCESS_TOKEN",
      "refreshToken": "YOUR_TESLA_REFRESH_TOKEN",
      "clientId": "YOUR_CLIENT_ID",
      "clientSecret": "YOUR_CLIENT_SECRET",
      "region": "EU",
      "vin": "",
      "pollInterval": 300,
      "proxyUrl": "",
      "dashcamOnSentry": true
    }
  ]
}
```

### Configuration Options

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `platform` | string | ✅ | — | Must be `"TeslaControl"` |
| `name` | string | ✅ | `"TeslaControl"` | Display name in Homebridge |
| `accessToken` | string | ✅ | — | Tesla Fleet API access token (JWT) |
| `refreshToken` | string | ✅ | — | Tesla Fleet API refresh token for auto-renewal |
| `clientId` | string | ✅ | — | From [Tesla Developer Portal](https://developer.tesla.com) |
| `clientSecret` | string | ✅ | — | From Tesla Developer Portal |
| `region` | string | ✅ | `"EU"` | API region: `"EU"`, `"NA"`, or `"CN"` |
| `vin` | string | ❌ | — | Specific vehicle VIN (if you have multiple Tesla vehicles) |
| `pollInterval` | integer | ❌ | `300` | Status polling interval in seconds (min: 60) |
| `proxyUrl` | string | ❌ | — | URL of tesla-http-proxy (e.g. `https://localhost:4443`) |
| `dashcamOnSentry` | boolean | ❌ | `true` | Auto-save dashcam clip when Sentry Mode is activated |

---

## Getting Tesla API Credentials

### 1. Register a Tesla Developer Application

1. Go to [developer.tesla.com](https://developer.tesla.com/)
2. Create a new application
3. Note your **Client ID** and **Client Secret**
4. Set the redirect URI (e.g. `https://localhost/callback`)

### 2. Obtain Access & Refresh Tokens

Use the Tesla OAuth 2.0 flow to get your tokens. You can use tools like:

- [Tesla Auth](https://github.com/adriankumpf/tesla_auth) (CLI)
- [Tesla Token](https://tesla-token.surge.sh/) (Web)

Or manually via cURL:

```bash
# Step 1: Get authorization code (open in browser)
https://auth.tesla.com/oauth2/v3/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=YOUR_REDIRECT_URI&response_type=code&scope=openid%20vehicle_device_data%20vehicle_cmds%20vehicle_charging_cmds%20offline_access

# Step 2: Exchange code for tokens
curl -X POST https://auth.tesla.com/oauth2/v3/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "code": "AUTH_CODE_FROM_STEP_1",
    "redirect_uri": "YOUR_REDIRECT_URI"
  }'
```

### 3. (Optional) Set Up Vehicle Command Proxy

For 2024+ Tesla vehicles, commands must be signed. Set up `tesla-http-proxy`:

```bash
# Install and run the proxy
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command/cmd/tesla-http-proxy
go build .
./tesla-http-proxy -port 4443 -key-file private.pem -cert server.pem
```

Then set `proxyUrl` in config to `https://localhost:4443`.

---

## Token Storage

Tokens are automatically cached and refreshed. The plugin looks for token storage in:

1. `/var/lib/homebridge/tesla_tokens.json` (default Homebridge data directory)
2. `~/.homebridge/tesla_tokens.json` (fallback)
3. System temp directory (last resort)

Tokens are refreshed proactively **5 minutes before expiry** to avoid interruptions.

---

## How It Works

1. **Discovery** — On launch, the plugin connects to Tesla Fleet API and discovers your vehicle
2. **Accessories** — Creates HomeKit accessories (lock, thermostat, switches, battery sensor)
3. **Polling** — Periodically polls vehicle status to keep HomeKit in sync
4. **Commands** — When you interact via HomeKit/Siri, commands are sent through Fleet API (or proxy)
5. **Wake-up** — If the vehicle is asleep, it's automatically woken before commands (with retry)

---

## HomeKit / Siri Examples

> "Hey Siri, lock the Tesla"
> "Hey Siri, set the Tesla climate to 22 degrees"
> "Hey Siri, turn on Sentry Mode"
> "Hey Siri, open the trunk"
> "Hey Siri, is the Tesla charging?"
> "Hey Siri, what's the Tesla battery level?"

---

## Troubleshooting

### Vehicle not found
- Verify your access token is valid and not expired
- Check that the `region` matches your Tesla account region
- If you have multiple vehicles, specify the `vin`

### Commands fail (403/422)
- For 2024+ vehicles, you need `tesla-http-proxy` configured via `proxyUrl`
- Ensure your Tesla Developer app has the required scopes: `vehicle_device_data`, `vehicle_cmds`, `vehicle_charging_cmds`

### Token refresh fails
- Check that `clientId` and `clientSecret` are correct
- Ensure the token file location is writable
- Check Homebridge logs for `[TeslaAPI]` messages

### Vehicle takes long to respond
- Tesla vehicles enter sleep mode to conserve battery
- The plugin will automatically wake the vehicle (up to 10 attempts, 3s apart)
- Increase `pollInterval` to let the vehicle sleep more (better for battery)

---

## API Regions

| Region | Code | Fleet API Host |
|---|---|---|
| Europe | `EU` | `fleet-api.prd.eu.vn.cloud.tesla.com` |
| North America | `NA` | `fleet-api.prd.na.vn.cloud.tesla.com` |
| China | `CN` | `fleet-api.prd.cn.vn.cloud.tesla.com` |

---

## License

MIT © [trama2000](https://github.com/trama2000)