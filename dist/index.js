"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const TeslaPlatform_1 = require("./TeslaPlatform");
module.exports = (api) => {
  api.registerPlatform("homebridge-tesla-vehicle-control", "TeslaControl", TeslaPlatform_1.TeslaPlatform);
};
