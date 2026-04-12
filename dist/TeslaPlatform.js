"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeslaPlatform = void 0;
const TeslaAPI_1 = require("./TeslaAPI");

class TeslaPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.vehicleId = null;
    this.vehicleData = null;
    this.pollInterval = (config.pollInterval || 300) * 1000;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.dashcamOnSentry = config.dashcamOnSentry !== false;

    this.tesla = new TeslaAPI_1.TeslaApi({
      accessToken: config.accessToken || "",
      refreshToken: config.refreshToken || "",
      clientId: config.clientId || "",
      clientSecret: config.clientSecret || "",
      region: config.region || "EU",
      vin: config.vin || "",
      proxyUrl: config.proxyUrl || "",
      log: (msg) => this.log(msg)
    });

    api.on("didFinishLaunching", () => {
      this.log("Tesla plugin v1.5.2 launched - Fleet API (partner registered)");
      this.discoverVehicle();
    });
  }

  async discoverVehicle() {
    try {
      this.log("Discovering Tesla vehicle...");
      const vehicle = await this.tesla.getVehicle();
      if (!vehicle) {
        this.retryCount++;
        if (this.retryCount <= this.maxRetries) {
          const delay = Math.min(30000 * this.retryCount, 300000);
          this.log("No vehicle found. Retry " + this.retryCount + "/" + this.maxRetries + " in " + (delay/1000) + "s");
          setTimeout(() => this.discoverVehicle(), delay);
        } else {
          this.log("No vehicle found after " + this.maxRetries + " retries. Check config and tokens.");
        }
        return;
      }
      this.retryCount = 0;
      this.vehicleId = vehicle.id_s || String(vehicle.id);
      this.log("Found vehicle: " + (vehicle.display_name || vehicle.vin) + " (ID: " + this.vehicleId + ", VIN: " + (vehicle.vin || "?") + ", State: " + (vehicle.state || "?") + ")");

      const uuid = this.api.hap.uuid.generate("tesla-vehicle-" + this.vehicleId);
      let existingAcc = this.accessories.find(a => a.UUID === uuid);
      if (!existingAcc) {
        const acc = new this.api.platformAccessory(vehicle.display_name || "Tesla", uuid);
        this.configureAccessory(acc);
        this.setupServices(acc);
        this.api.registerPlatformAccessories("homebridge-tesla-vehicle-control", "TeslaControl", [acc]);
        this.log("Registered new accessory: " + (vehicle.display_name || "Tesla"));
      } else {
        this.setupServices(existingAcc);
        this.log("Restored cached accessory: " + (vehicle.display_name || "Tesla"));
      }
      this.startPolling();
    } catch (e) {
      this.retryCount++;
      if (this.retryCount <= this.maxRetries) {
        const delay = Math.min(30000 * this.retryCount, 300000);
        this.log("Discovery error: " + e.message + ". Retry in " + (delay/1000) + "s");
        setTimeout(() => this.discoverVehicle(), delay);
      }
    }
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  setupServices(accessory) {
    const S = this.Service;
    const C = this.Characteristic;

    // Lock
    let lockService = accessory.getService(S.LockMechanism) || accessory.addService(S.LockMechanism, "Cerradura", "lock");
    lockService.getCharacteristic(C.LockTargetState).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value === C.LockTargetState.SECURED) { await this.tesla.lock(this.vehicleId); this.log("Locked"); }
        else { await this.tesla.unlock(this.vehicleId); this.log("Unlocked"); }
      } catch (e) { this.log("Lock error: " + e.message); }
    });

    // Climate (Thermostat)
    let thermoService = accessory.getService(S.Thermostat) || accessory.addService(S.Thermostat, "Clima", "climate");
    thermoService.getCharacteristic(C.TargetHeatingCoolingState).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value === C.TargetHeatingCoolingState.OFF) { await this.tesla.climateOff(this.vehicleId); this.log("Climate OFF"); }
        else { await this.tesla.climateOn(this.vehicleId); this.log("Climate ON"); }
      } catch (e) { this.log("Climate error: " + e.message); }
    });
    thermoService.getCharacteristic(C.TargetTemperature).onSet(async (value) => {
      try {
        await this._ensureAwake();
        await this.tesla.setTemp(this.vehicleId, value, value);
        this.log("Temperature set to " + value + "C");
      } catch (e) { this.log("Temperature error: " + e.message); }
    });
    thermoService.getCharacteristic(C.TemperatureDisplayUnits).onGet(() => C.TemperatureDisplayUnits.CELSIUS);
    thermoService.getCharacteristic(C.TargetTemperature).setProps({ minValue: 15, maxValue: 28, minStep: 0.5 });

    // Sentry Mode (with optional dashcam save)
    let sentryService = accessory.getServiceById(S.Switch, "sentry") || accessory.addService(S.Switch, "Sentry Mode", "sentry");
    sentryService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) {
          await this.tesla.sentryOn(this.vehicleId);
          this.log("Sentry ON");
          if (this.dashcamOnSentry) {
            try {
              await this.tesla.saveDashcam(this.vehicleId);
              this.log("Dashcam clip saved (Sentry activated)");
            } catch (de) { this.log("Dashcam save warning: " + de.message); }
          }
        } else {
          await this.tesla.sentryOff(this.vehicleId);
          this.log("Sentry OFF");
        }
      } catch (e) { this.log("Sentry error: " + e.message); }
    });

    // Trunk (momentary)
    let trunkService = accessory.getServiceById(S.Switch, "trunk") || accessory.addService(S.Switch, "Trunk", "trunk");
    trunkService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.openTrunk(this.vehicleId); this.log("Trunk opened"); }
        setTimeout(() => trunkService.updateCharacteristic(C.On, false), 3000);
      } catch (e) { this.log("Trunk error: " + e.message); }
    });

    // Frunk (momentary)
    let frunkService = accessory.getServiceById(S.Switch, "frunk") || accessory.addService(S.Switch, "Frunk", "frunk");
    frunkService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.openFrunk(this.vehicleId); this.log("Frunk opened"); }
        setTimeout(() => frunkService.updateCharacteristic(C.On, false), 3000);
      } catch (e) { this.log("Frunk error: " + e.message); }
    });

    // Charge Port
    let chargePortService = accessory.getServiceById(S.Switch, "chargeport") || accessory.addService(S.Switch, "Charge Port", "chargeport");
    chargePortService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) { await this.tesla.openChargePort(this.vehicleId); this.log("Charge port opened"); }
        else { await this.tesla.closeChargePort(this.vehicleId); this.log("Charge port closed"); }
      } catch (e) { this.log("Charge port error: " + e.message); }
    });

    // Charging
    let chargingService = accessory.getServiceById(S.Switch, "charging") || accessory.addService(S.Switch, "Charging", "charging");
    chargingService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) { await this.tesla.startCharging(this.vehicleId); this.log("Charging started"); }
        else { await this.tesla.stopCharging(this.vehicleId); this.log("Charging stopped"); }
      } catch (e) { this.log("Charging error: " + e.message); }
    });

    // Flash Lights (momentary)
    let flashService = accessory.getServiceById(S.Switch, "flash") || accessory.addService(S.Switch, "Flash Light", "flash");
    flashService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.flashLights(this.vehicleId); this.log("Lights flashed"); }
        setTimeout(() => flashService.updateCharacteristic(C.On, false), 2000);
      } catch (e) { this.log("Flash error: " + e.message); }
    });

    // Horn (momentary)
    let hornService = accessory.getServiceById(S.Switch, "horn") || accessory.addService(S.Switch, "Horn", "horn");
    hornService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.honkHorn(this.vehicleId); this.log("Horn honked"); }
        setTimeout(() => hornService.updateCharacteristic(C.On, false), 2000);
      } catch (e) { this.log("Horn error: " + e.message); }
    });

    // Dashcam Save (momentary)
    let dashcamService = accessory.getServiceById(S.Switch, "dashcam") || accessory.addService(S.Switch, "Dashcam", "dashcam");
    dashcamService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.saveDashcam(this.vehicleId); this.log("Dashcam clip saved"); }
        setTimeout(() => dashcamService.updateCharacteristic(C.On, false), 2000);
      } catch (e) { this.log("Dashcam error: " + e.message); }
    });

    // Vent Windows (toggle)
    let ventService = accessory.getServiceById(S.Switch, "vent") || accessory.addService(S.Switch, "Ventanas", "vent");
    ventService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) { await this.tesla.ventWindows(this.vehicleId); this.log("Windows vented"); }
        else { await this.tesla.closeWindows(this.vehicleId); this.log("Windows closed"); }
      } catch (e) { this.log("Windows error: " + e.message); }
    });

    // Defrost (toggle)
    let defrostService = accessory.getServiceById(S.Switch, "defrost") || accessory.addService(S.Switch, "Defrost", "defrost");
    defrostService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) { await this.tesla.defrostOn(this.vehicleId); this.log("Defrost ON"); }
        else { await this.tesla.defrostOff(this.vehicleId); this.log("Defrost OFF"); }
      } catch (e) { this.log("Defrost error: " + e.message); }
    });

    // Steering Wheel Heater (toggle)
    let steeringService = accessory.getServiceById(S.Switch, "steeringheater") || accessory.addService(S.Switch, "Volante Calef.", "steeringheater");
    steeringService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        await this.tesla.steeringWheelHeater(this.vehicleId, value);
        this.log("Steering wheel heater " + (value ? "ON" : "OFF"));
      } catch (e) { this.log("Steering heater error: " + e.message); }
    });

    // Charge Limit (Lightbulb brightness = 50-100%)
    let chargeLimitService = accessory.getServiceById(S.Lightbulb, "chargelimit") || accessory.addService(S.Lightbulb, "Limite Carga", "chargelimit");
    chargeLimitService.getCharacteristic(C.On).onGet(() => true);
    chargeLimitService.getCharacteristic(C.On).onSet(async () => {});
    chargeLimitService.getCharacteristic(C.Brightness).onGet(() => {
      if (this.vehicleData && this.vehicleData.charge_state) {
        return this.vehicleData.charge_state.charge_limit_soc || 80;
      }
      return 80;
    });
    chargeLimitService.getCharacteristic(C.Brightness).onSet(async (value) => {
      try {
        await this._ensureAwake();
        const limit = Math.max(50, Math.min(100, value));
        await this.tesla.setChargeLimit(this.vehicleId, limit);
        this.log("Charge limit set to " + limit + "%");
      } catch (e) { this.log("Charge limit error: " + e.message); }
    });
    chargeLimitService.getCharacteristic(C.Brightness).setProps({ minValue: 50, maxValue: 100, minStep: 5 });

    // Battery Level - using TemperatureSensor to show % as big tile
    let batteryTemp = accessory.getServiceById(S.TemperatureSensor, "batterypct") || accessory.addService(S.TemperatureSensor, "Bateria", "batterypct");
    batteryTemp.getCharacteristic(C.CurrentTemperature).onGet(() => {
      if (this.vehicleData && this.vehicleData.charge_state) {
        return this.vehicleData.charge_state.battery_level || 0;
      }
      return 0;
    });
    batteryTemp.getCharacteristic(C.CurrentTemperature).setProps({ minValue: 0, maxValue: 100, minStep: 1 });

    // Battery Service (native - shows in accessory details)
    let batteryService = accessory.getService(S.Battery) || accessory.addService(S.Battery, "Battery", "battery");

    // Info
    let infoService = accessory.getService(S.AccessoryInformation) || accessory.addService(S.AccessoryInformation);
    infoService.setCharacteristic(C.Manufacturer, "Tesla");
    infoService.setCharacteristic(C.Model, "Vehicle");
    infoService.setCharacteristic(C.SerialNumber, this.config.vin || "Unknown");
    infoService.setCharacteristic(C.FirmwareRevision, "1.4.2");
  }

  async _ensureAwake() {
    const lastPoll = this._lastPollTime || 0;
    const elapsed = Date.now() - lastPoll;
    if (this.vehicleData && this.vehicleData.state === "online" && elapsed < 120000) return;
    this.log("Vehicle may be asleep (last poll " + Math.round(elapsed/1000) + "s ago), waking...");
    await this.tesla.wakeUp(this.vehicleId);
    if (this.vehicleData) this.vehicleData.state = "online";
  }

  async startPolling() {
    const poll = async () => {
      try {
        this.log("Polling vehicle data...");
        const r = await this.tesla.getVehicleData(this.vehicleId);
        this.log("Poll response: " + (r ? JSON.stringify(r).substring(0, 200) : "null"));
        if (r && r.response) {
          this.vehicleData = r.response;
        this._lastPollTime = Date.now();
          this.log("Got vehicle data - battery: " + (r.response.charge_state ? r.response.charge_state.battery_level + "%" : "no charge_state") + ", locked: " + (r.response.vehicle_state ? r.response.vehicle_state.locked : "no vehicle_state"));
          this.updateAccessories();
        } else if (r) {
          // Fleet API may return data directly without .response wrapper
          if (r.charge_state || r.vehicle_state || r.climate_state) {
            this.vehicleData = r;
            this.log("Got vehicle data (unwrapped) - battery: " + (r.charge_state ? r.charge_state.battery_level + "%" : "no charge_state"));
            this.updateAccessories();
          } else {
            this.log("Poll returned unexpected format: " + JSON.stringify(r).substring(0, 300));
          }
        }
      } catch (e) {
        if (e.message && !e.message.includes("408")) {
          this.log("Poll error: " + e.message);
        }
      }
    };
    try { await poll(); } catch (e) { this.log("Initial poll failed: " + e.message); }
    setInterval(poll, this.pollInterval);
  }

  updateAccessories() {
    if (!this.vehicleData) return;
    const C = this.Characteristic;
    const S = this.Service;
    for (const acc of this.accessories) {
      // Lock
      const lockService = acc.getService(S.LockMechanism);
      if (lockService && this.vehicleData.vehicle_state) {
        const locked = this.vehicleData.vehicle_state.locked;
        lockService.updateCharacteristic(C.LockCurrentState, locked ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED);
        lockService.updateCharacteristic(C.LockTargetState, locked ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED);
      }

      // Climate
      const thermoService = acc.getService(S.Thermostat);
      if (thermoService && this.vehicleData.climate_state) {
        const cs = this.vehicleData.climate_state;
        const isOn = cs.is_climate_on;
        thermoService.updateCharacteristic(C.CurrentHeatingCoolingState, isOn ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
        if (cs.inside_temp !== undefined) thermoService.updateCharacteristic(C.CurrentTemperature, cs.inside_temp);
        if (cs.driver_temp_setting !== undefined) thermoService.updateCharacteristic(C.TargetTemperature, cs.driver_temp_setting);
      }

      // Sentry
      const sentryService = acc.getServiceById(S.Switch, "sentry");
      if (sentryService && this.vehicleData.vehicle_state) {
        sentryService.updateCharacteristic(C.On, !!this.vehicleData.vehicle_state.sentry_mode);
      }

      // Charging
      const chargingService = acc.getServiceById(S.Switch, "charging");
      if (chargingService && this.vehicleData.charge_state) {
        chargingService.updateCharacteristic(C.On, this.vehicleData.charge_state.charging_state === "Charging");
      }

      // Battery % (TemperatureSensor tile)
      const batteryTemp = acc.getServiceById(S.TemperatureSensor, "batterypct");
      if (batteryTemp && this.vehicleData.charge_state) {
        const level = this.vehicleData.charge_state.battery_level || 0;
        batteryTemp.updateCharacteristic(C.CurrentTemperature, level);
      }

      // Battery (native service)
      const batteryService = acc.getService(S.Battery);
      if (batteryService && this.vehicleData.charge_state) {
        const level = this.vehicleData.charge_state.battery_level || 0;
        batteryService.updateCharacteristic(C.BatteryLevel, level);
        batteryService.updateCharacteristic(C.StatusLowBattery, level < 20 ? 1 : 0);
        const isCharging = this.vehicleData.charge_state.charging_state === "Charging";
        batteryService.updateCharacteristic(C.ChargingState, isCharging ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING);
      }

      // Charge Limit
      const chargeLimitService = acc.getServiceById(S.Lightbulb, "chargelimit");
      if (chargeLimitService && this.vehicleData.charge_state) {
        const limit = this.vehicleData.charge_state.charge_limit_soc || 80;
        chargeLimitService.updateCharacteristic(C.Brightness, limit);
      }

      // Defrost
      const defrostService = acc.getServiceById(S.Switch, "defrost");
      if (defrostService && this.vehicleData.climate_state) {
        defrostService.updateCharacteristic(C.On, !!this.vehicleData.climate_state.defrost_mode);
      }

      // Steering Wheel Heater
      const steeringService = acc.getServiceById(S.Switch, "steeringheater");
      if (steeringService && this.vehicleData.climate_state) {
        steeringService.updateCharacteristic(C.On, !!this.vehicleData.climate_state.steering_wheel_heater);
      }

      // Windows (vent state)
      const ventService = acc.getServiceById(S.Switch, "vent");
      if (ventService && this.vehicleData.vehicle_state) {
        const vs = this.vehicleData.vehicle_state;
        const anyOpen = (vs.fd_window > 0 || vs.fp_window > 0 || vs.rd_window > 0 || vs.rp_window > 0);
        ventService.updateCharacteristic(C.On, anyOpen);
      }
    }
  }
}

exports.TeslaPlatform = TeslaPlatform;