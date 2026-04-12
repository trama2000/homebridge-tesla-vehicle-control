"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeslaApi = void 0;
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");
const os = require("os");

const FLEET_API_HOSTS = {
  EU: "fleet-api.prd.eu.vn.cloud.tesla.com",
  NA: "fleet-api.prd.na.vn.cloud.tesla.com",
  CN: "fleet-api.prd.cn.vn.cloud.tesla.com"
};

function getDefaultTokenPath() {
  const candidates = [
    "/var/lib/homebridge/tesla_tokens.json",
    path.join(os.homedir(), ".homebridge", "tesla_tokens.json"),
    path.join(os.tmpdir(), "tesla_tokens.json")
  ];
  for (const p of candidates) {
    const dir = path.dirname(p);
    try {
      if (fs.existsSync(dir)) {
        fs.accessSync(dir, fs.constants.W_OK);
        return p;
      }
    } catch (e) {}
  }
  return candidates[candidates.length - 1];
}

class TeslaApi {
  constructor(config) {
    this.accessToken = config.accessToken || "";
    this.refreshToken = config.refreshToken || "";
    this.clientId = config.clientId || "";
    this.clientSecret = config.clientSecret || "";
    this.region = config.region || "EU";
    this.vin = config.vin || "";
    this.baseHost = FLEET_API_HOSTS[this.region] || FLEET_API_HOSTS.EU;
    this.proxyUrl = config.proxyUrl || "";
    if (this.proxyUrl) {
      const proxyParts = new URL(this.proxyUrl);
      this.proxyHost = proxyParts.hostname;
      this.proxyPort = parseInt(proxyParts.port) || 4443;
    }
    this.tokenPath = config.tokenPath || getDefaultTokenPath();
    this.log = config.log || console.log;
    this._refreshing = false;
    this.log("[TeslaAPI] Region: " + this.region + " -> " + this.baseHost);
    this.log("[TeslaAPI] Token cache: " + this.tokenPath);
    this.log("[TeslaAPI] VIN filter: " + (this.vin || "none (first vehicle)"));
    if (this.proxyUrl) this.log("[TeslaAPI] Command Proxy: " + this.proxyUrl);
    else this.log("[TeslaAPI] Command Proxy: not configured (commands sent directly to Fleet API)");
    this._loadTokens();
  }

  _loadTokens() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        const data = JSON.parse(fs.readFileSync(this.tokenPath, "utf8"));
        if (data.accessToken) this.accessToken = data.accessToken;
        if (data.refreshToken) this.refreshToken = data.refreshToken;
        if (data.expiresAt) this.expiresAt = data.expiresAt;
        this.log("[TeslaAPI] Loaded cached tokens (expires: " + (this.expiresAt ? new Date(this.expiresAt).toISOString() : "unknown") + ")");
      }
    } catch (e) {
      this.log("[TeslaAPI] No cached tokens: " + e.message);
    }
  }

  _saveTokens() {
    try {
      const dir = path.dirname(this.tokenPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.tokenPath, JSON.stringify({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt }, null, 2));
      this.log("[TeslaAPI] Tokens saved to " + this.tokenPath);
    } catch (e) {
      this.log("[TeslaAPI] Failed to save tokens: " + e.message);
      try {
        const fallback = path.join(os.tmpdir(), "tesla_tokens.json");
        fs.writeFileSync(fallback, JSON.stringify({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt }, null, 2));
        this.tokenPath = fallback;
        this.log("[TeslaAPI] Tokens saved to fallback: " + fallback);
      } catch (e2) {
        this.log("[TeslaAPI] Fallback save also failed: " + e2.message);
      }
    }
  }

  async _refreshAccessToken() {
    if (this._refreshing) {
      this.log("[TeslaAPI] Token refresh already in progress, waiting...");
      await new Promise(r => setTimeout(r, 5000));
      return;
    }
    this._refreshing = true;
    try {
      if (!this.refreshToken) throw new Error("No refresh token");
      if (!this.clientId || !this.clientSecret) throw new Error("No clientId/clientSecret");
      this.log("[TeslaAPI] Refreshing access token...");
      const postData = querystring.stringify({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken
      });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "auth.tesla.com", port: 443, path: "/oauth2/v3/token", method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
        }, (res) => {
          let body = "";
          res.on("data", c => body += c);
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              if (res.statusCode === 200 && data.access_token) {
                resolve(data);
              } else {
                reject(new Error("Token refresh failed: HTTP " + res.statusCode + " - " + body.substring(0, 200)));
              }
            } catch (e) { reject(new Error("Token refresh parse error: " + body.substring(0, 200))); }
          });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
      });
      this.accessToken = result.access_token;
      if (result.refresh_token) this.refreshToken = result.refresh_token;
      this.expiresAt = Date.now() + ((result.expires_in || 28800) * 1000);
      this._saveTokens();
      this.log("[TeslaAPI] Token refreshed OK, expires: " + new Date(this.expiresAt).toISOString());
    } finally {
      this._refreshing = false;
    }
  }

  async _ensureToken() {
    if (this.expiresAt && Date.now() > this.expiresAt - 300000) {
      this.log("[TeslaAPI] Token expired or expiring soon, refreshing...");
      await this._refreshAccessToken();
    }
  }

  async _request(method, urlPath, body, isRetry) {
    try { await this._ensureToken(); } catch (e) { this.log("[TeslaAPI] Token check: " + e.message); }
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseHost, port: 443, path: urlPath, method: method,
        headers: { "Authorization": "Bearer " + this.accessToken, "Content-Type": "application/json", "Accept": "application/json" }
      };
      this.log("[TeslaAPI] " + method + " " + urlPath + (isRetry ? " (retry)" : ""));
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          this.log("[TeslaAPI] Response " + res.statusCode + " (" + data.length + " bytes)");
          if (res.statusCode === 401 && !isRetry && this.refreshToken) {
            this.log("[TeslaAPI] 401 received, refreshing token and retrying...");
            this._refreshAccessToken().then(() => {
              this._request(method, urlPath, body, true).then(resolve).catch(reject);
            }).catch(e => {
              this.log("[TeslaAPI] Token refresh failed: " + e.message);
              reject(e);
            });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              this.log("[TeslaAPI] Error " + res.statusCode + ": " + data.substring(0, 500));
            }
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            this.log("[TeslaAPI] Non-JSON response: " + data.substring(0, 500));
            resolve({ status: res.statusCode, data: { raw: data } });
          }
        });
      });
      req.on("error", (e) => {
        this.log("[TeslaAPI] Request error: " + e.message);
        reject(e);
      });
      if (body && method !== "GET") req.write(JSON.stringify(body));
      req.end();
    });
  }

  async getVehicles() {
    this.log("[TeslaAPI] Fetching vehicle list...");
    try {
      const r = await this._request("GET", "/api/1/vehicles");
      this.log("[TeslaAPI] getVehicles HTTP " + r.status);
      this.log("[TeslaAPI] getVehicles raw response: " + JSON.stringify(r.data).substring(0, 500));
      if (r.data && r.data.response && Array.isArray(r.data.response)) {
        this.log("[TeslaAPI] Found " + r.data.response.length + " vehicle(s)");
        r.data.response.forEach((v, i) => {
          this.log("[TeslaAPI] Vehicle " + i + ": " + (v.display_name || "unnamed") + " VIN=" + (v.vin || "?") + " id=" + v.id + " state=" + v.state);
        });
        return r.data.response;
      }
      if (r.data && Array.isArray(r.data)) {
        this.log("[TeslaAPI] Response is direct array with " + r.data.length + " items");
        return r.data;
      }
      this.log("[TeslaAPI] No vehicles in response structure");
      return [];
    } catch (e) {
      this.log("[TeslaAPI] getVehicles ERROR: " + e.message);
      this.log("[TeslaAPI] Error stack: " + (e.stack || "no stack"));
      return [];
    }
  }

  async getVehicle() {
    const vehicles = await this.getVehicles();
    this.log("[TeslaAPI] getVehicle: " + vehicles.length + " vehicles available");
    if (vehicles.length === 0) return null;
    if (this.vin) {
      const match = vehicles.find(v => v.vin === this.vin);
      if (match) { this.log("[TeslaAPI] Matched VIN " + this.vin); return match; }
      this.log("[TeslaAPI] VIN " + this.vin + " not found in list, using first");
    }
    return vehicles[0];
  }

  async wakeUp(vehicleId) {
    this.log("[TeslaAPI] Waking up vehicle " + vehicleId + " via Fleet API");
    await this._request("POST", "/api/1/vehicles/" + vehicleId + "/wake_up");
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const check = await this._request("GET", "/api/1/vehicles/" + vehicleId);
        if (check.data && check.data.response && check.data.response.state === "online") {
          this.log("[TeslaAPI] Vehicle is online");
          return check.data.response;
        }
      } catch (e) {}
      this.log("[TeslaAPI] Wake attempt " + (i+1) + "/10...");
    }
    this.log("[TeslaAPI] Wake timeout - proceeding anyway");
  }
  async getVehicleData(vehicleId) {
    const endpoints = "charge_state;climate_state;vehicle_state;drive_state;vehicle_config";
    const r = await this._request("GET", "/api/1/vehicles/" + vehicleId + "/vehicle_data?endpoints=" + encodeURIComponent(endpoints));
    return r.data;
  }


  async _proxyCommand(vehicleId, command, body) {
    try { await this._ensureToken(); } catch (e) { this.log("[TeslaAPI] Token check: " + e.message); }
    return new Promise((resolve, reject) => {
      const vin = this.vin || vehicleId;
      const urlPath = "/api/1/vehicles/" + vin + "/command/" + command;
      const postData = JSON.stringify(body || {});
      this.log("[TeslaAPI] Proxy POST " + urlPath + " -> " + this.proxyHost + ":" + this.proxyPort);
      const options = {
        hostname: this.proxyHost, port: this.proxyPort, path: urlPath, method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + this.accessToken,
          "Content-Length": Buffer.byteLength(postData)
        },
        rejectUnauthorized: false
      };
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          this.log("[TeslaAPI] Proxy response " + res.statusCode + " (" + data.length + " bytes)");
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              this.log("[TeslaAPI] Proxy error " + res.statusCode + ": " + data.substring(0, 300));
              reject(new Error("Proxy command failed: " + res.statusCode));
            } else {
              this.log("[TeslaAPI] Proxy command OK: " + command);
              resolve(parsed);
            }
          } catch (e) {
            this.log("[TeslaAPI] Proxy parse error: " + data.substring(0, 200));
            reject(new Error("Proxy response parse error"));
          }
        });
      });
      req.on("error", (e) => {
        this.log("[TeslaAPI] Proxy connection error: " + e.message);
        this.log("[TeslaAPI] Is tesla-http-proxy running on " + this.proxyHost + ":" + this.proxyPort + "?");
        reject(e);
      });
      req.write(postData);
      req.end();
    });
  }

    async sendCommand(vehicleId, command, body) {
    this.log("[TeslaAPI] Command: " + command);
    if (this.proxyUrl) {
      try {
        return await this._proxyCommand(vehicleId, command, body);
      } catch (e) {
        const msg = e.message || "";
        if (msg.includes("500") || msg.includes("408") || msg.includes("vehicle unavailable") || msg.includes("offline or asleep")) {
          this.log("[TeslaAPI] Vehicle asleep on proxy, waking...");
          await this.wakeUp(vehicleId);
          this.log("[TeslaAPI] Retrying " + command + " after wake...");
          return await this._proxyCommand(vehicleId, command, body);
        }
        throw e;
      }
    }
    const r = await this._request("POST", "/api/1/vehicles/" + vehicleId + "/command/" + command, body || {});
    if (r.status === 408 || (r.data && r.data.error === "vehicle unavailable")) {
      this.log("[TeslaAPI] Vehicle asleep, waking...");
      await this.wakeUp(vehicleId);
      return (await this._request("POST", "/api/1/vehicles/" + vehicleId + "/command/" + command, body || {})).data;
    }
    return r.data;
  }
  async lock(id) { return this.sendCommand(id, "door_lock"); }
  async unlock(id) { return this.sendCommand(id, "door_unlock"); }
  async climateOn(id) { return this.sendCommand(id, "auto_conditioning_start"); }
  async climateOff(id) { return this.sendCommand(id, "auto_conditioning_stop"); }
  async setTemp(id, d, p) { return this.sendCommand(id, "set_temps", { driver_temp: d, passenger_temp: p || d }); }
  async sentryOn(id) { return this.sendCommand(id, "set_sentry_mode", { on: true }); }
  async sentryOff(id) { return this.sendCommand(id, "set_sentry_mode", { on: false }); }
  async openTrunk(id) { return this.sendCommand(id, "actuate_trunk", { which_trunk: "rear" }); }
  async openFrunk(id) { return this.sendCommand(id, "actuate_trunk", { which_trunk: "front" }); }
  async openChargePort(id) { return this.sendCommand(id, "charge_port_door_open"); }
  async closeChargePort(id) { return this.sendCommand(id, "charge_port_door_close"); }
  async chargeStart(id) { return this.sendCommand(id, "charge_start"); }
  async chargeStop(id) { return this.sendCommand(id, "charge_stop"); }
  async setChargeLimit(id, pct) { return this.sendCommand(id, "set_charge_limit", { percent: pct }); }
  async flashLights(id) { return this.sendCommand(id, "flash_lights"); }
  async honkHorn(id) { return this.sendCommand(id, "honk_horn"); }
  async ventWindows(id) { return this.sendCommand(id, "window_control", { command: "vent", lat: 0, lon: 0 }); }
  async closeWindows(id) { return this.sendCommand(id, "window_control", { command: "close", lat: 0, lon: 0 }); }
  async seatHeater(id, seat, level) { return this.sendCommand(id, "remote_seat_heater_request", { heater: seat, level: level }); }
  async steeringWheelHeater(id, on) { return this.sendCommand(id, "remote_steering_wheel_heater_request", { on: on }); }


  async defrostOn(id) { return this.sendCommand(id, "set_preconditioning_max", { on: true }); }
  async defrostOff(id) { return this.sendCommand(id, "set_preconditioning_max", { on: false }); }

  async saveDashcam(id) { return this.sendCommand(id, "trigger_dashcam_save_clip"); }
  async startCharging(id) { return this.chargeStart(id); }
  async stopCharging(id) { return this.chargeStop(id); }}

exports.TeslaApi = TeslaApi;