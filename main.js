"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions

const utils = require("@iobroker/adapter-core");
// The net module is used to create TCP clients and servers
const net = require("net");

/**
 * Adapter class for UVR16xx BL-NET devices.
 * @extends utils.Adapter
 */
class Uvr16xxBlNet extends utils.Adapter {
    /**
     * Constructor for the adapter instance
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "uvr16xx-blnet",
        });
        this.on("ready", this.onReady.bind(this)); // Bind the onReady method
        this.on("stateChange", this.onStateChange.bind(this)); // Bind the onStateChange method
        // this.on("objectChange", this.onObjectChange.bind(this)); // Uncomment to bind the onObjectChange method
        // this.on("message", this.onMessage.bind(this)); // Uncomment to bind the onMessage method
        this.on("unload", this.onUnload.bind(this)); // Bind the onUnload method
    }

    /**
     * Is called when the adapter is ready
     */
    async onReady() {
        // The adapter's config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        this.log.info("config ip_address: " + this.config.ip_address);
        this.log.info("config port: " + this.config.port);
        this.log.info("config poll_interval: " + this.config.poll_interval);

        // create status for adapter initialization success
        this.initialized = false;

        // Start polling
        this.startPolling();
    }

    /**
     * Polling function to fetch state values from the IoT device at regular intervals.
     */
    startPolling() {
        const pollInterval = this.config.poll_interval * 1000; // Poll interval in milliseconds

        this.pollingInterval = setInterval(async () => {
            // Perform an initialization read attempt, if failed do not start polling
            if (!this.initialized) {
                try {
                    const systemConfiguration = await this.readSystemConfiguration();

                    // Set status for info.connection
                    this.log.debug("Setting connection status to: " + systemConfiguration.success);
                    await this.setState("info.connection", systemConfiguration.success, true);
                    if (systemConfiguration.success === true) {
                        // Declare objects
                        await this.declareObjects(systemConfiguration);

                        this.initialized = true;
                        this.log.debug("Initialization succeeded: ");
                    }
                } catch (error) {
                    this.log.error("Initialization failed: " + error);
                    return; // Lock polling if initialization fails
                }
            }

            // Perform polling operations only if initialization was successful
            if (this.initialized) {
                try {
                    const stateValues = await this.fetchStateValuesFromDevice();
                    await this.setState("info.connection", true, true);

                    for (const [key, value] of Object.entries(stateValues)) {
                        if (typeof value === "object" && value !== null) {
                            for (const [subKey, subValue] of Object.entries(value)) {
                                const stateKey = key + "." + subKey;
                                let finalValue = subValue;

                                // Process input values: filter bits 4-6 and handle sign bit
                                if (key === "inputs") {
                                    if (typeof subValue === "number") {
                                        const highByte = subValue >> 8;
                                        const lowByte = subValue & 0xFF;
                                        const signBit = highByte & 0x80;
                                        const unitBits = highByte & 0x70;
                                        let input = this.byte2short(lowByte, highByte & 0x0F);
                                        if (signBit) {
                                            // Restore bits 4, 5, 6 with 1, since this is a negative number
                                            input = input | 0xF000;
                                            // Invert the bits (ensure 16-bit operation)
                                            input = (~input & 0xFFFF);
                                            // Add 1 to the inverted bits
                                            input = (input + 1) & 0xFFFF;
                                            // Set the value to negative
                                            input = -input;
                                        }
                                        if (unitBits === 0x20) { // °C
                                            finalValue = input / 10.0; // Assuming input is in tenths of degrees
                                        } else {
                                            finalValue = input;
                                        }
                                        this.log.debug("Setting state " + stateKey + " to value " + finalValue + " as type " + this.determineUnit(unitBits));
                                    } else {
                                        this.log.error("Invalid subValue structure for " + stateKey + ": " + JSON.stringify(subValue));
                                    }
                                }

                                // Update the state in ioBroker
                                await this.setState(stateKey, {
                                    val: finalValue,
                                    ack: true
                                });
                            }
                        } else {
                            this.log.debug("Setting state " + key + " to value " + value);
                            // Update the state in ioBroker
                            await this.setState(key, {
                                val: value,
                                ack: true
                            });
                        }
                    }
                    this.log.info("Polled state values from the IoT device");
                } catch (error) {
                    await this.setState("info.connection", false, true);
                    this.log.error("Error polling state values: " + error);
                }
            }
        }, pollInterval); // Poll every pollInterval milliseconds
    }

    /**
     * Performs a test read from the device to determine input units.
     * @returns {Promise<{success: boolean, stateValues: Object, deviceInfo: Object, units: Object}>} - The result of the test read with success status, state values, device info, and units.
     */
    async readSystemConfiguration() {
        let stateValues;
        let deviceInfo;

        // Try to read some metadata on the device
        try {
            deviceInfo = await this.readDeviceInfo();
            this.log.debug("deviceInfo is defined as:" + JSON.stringify(deviceInfo));
        } catch (error) {
            this.log.debug("readDeviceInfo function error: " + error);
            return {
                success: false,
                stateValues: {},
                deviceInfo: {},
                units: {}
            };
        }

        try {
            stateValues = await this.fetchStateValuesFromDevice();
            const units = {};

            // Determine units based on bits 4-6 of the high byte for inputs
            for (const [key, value] of Object.entries(stateValues.inputs)) {
                if (typeof value === "number") {
                    const highByte = value >> 8;
                    const unitBits = highByte & 0x70;
                    const unit = this.determineUnit(unitBits);
                    units[key] = unit;
                } else {
                    this.log.error("Invalid input value for " + key + ": " + JSON.stringify(value));
                }
            }

            this.log.info("readDeviceInfo succeeded.");
            return {
                success: true,
                stateValues: stateValues,
                deviceInfo: deviceInfo,
                units: units
            };
        } catch (error) {
            this.log.error("readDeviceInfo failed: " + error);
            return {
                success: false,
                stateValues: {},
                deviceInfo: {},
                units: {}
            };
        }
    }

    /**
     * Determine the unit based on the unitBits
     * @param {number} unitBits - The bits representing the unit
     * @returns {string} - The determined unit as a string
     */
    determineUnit(unitBits) {
        switch (unitBits) {
            case 0x00:
                return "unused"; // No unit
            case 0x10:
                return "digital"; // Digital unit
            case 0x20:
                return "°C"; // Temperature in Celsius
            case 0x30:
                return "l/h"; // Flow rate in liters per hour
            case 0x60:
                return "W/m²"; // Power per square meter
            case 0x70:
                return "°C (room sensor)"; // Room temperature sensor in Celsius
            default:
                return "unknown"; // Unknown unit
        }
    }

    /**
     * Declare objects in ioBroker based on the provided units.
     * @param {Object} systemConfiguration - The systemConfiguration determined from the device info reading.
     */
    async declareObjects(systemConfiguration) {
        const units = systemConfiguration.units;
        const deviceInfo = systemConfiguration.deviceInfo;

        // Check if deviceInfo is defined
        if (deviceInfo) {
            // Declare device information
            for (const [key, value] of Object.entries(deviceInfo)) {
                await this.setObjectNotExistsAsync("info." + key, {
                    type: "state",
                    common: {
                        name: key,
                        type: "string",
                        role: "indicator",
                        read: true,
                        write: false,
                        def: value // Set initial value
                    },
                    native: {},
                });
                await this.setState("info." + key, {
                    val: value,
                    ack: true
                });
            }
        } else {
            this.log.error("deviceInfo is undefined or null");
        }
        // Declare outputs
        const outputs = {
            "A01": "OFF", // Byte 1, Bit 0
            "A02": "OFF", // Byte 1, Bit 1
            "A03": "OFF", // Byte 1, Bit 2
            "A04": "OFF", // Byte 1, Bit 3
            "A05": "OFF", // Byte 1, Bit 4
            "A06": "OFF", // Byte 1, Bit 5
            "A07": "OFF", // Byte 1, Bit 6
            "A08": "OFF", // Byte 1, Bit 7
            "A09": "OFF", // Byte 2, Bit 0
            "A10": "OFF", // Byte 2, Bit 1
            "A11": "OFF", // Byte 2, Bit 2
            "A12": "OFF", // Byte 2, Bit 3
            "A13": "OFF" // Byte 2, Bit 4
        };

        for (const key of Object.keys(outputs)) {
            await this.setObjectNotExistsAsync("outputs." + key, {
                type: "state",
                common: {
                    name: key,
                    type: "string",
                    role: "indicator",
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        // Declare speed levels
        const speedLevels = {
            "DzA1": 0, // Speed level 1
            "DzA2": 30, // Speed level 2
            "DzA6": 14, // Speed level 6
            "DzA7": 158 // Speed level 7
        };

        for (const key of Object.keys(speedLevels)) {
            await this.setObjectNotExistsAsync("speed_levels." + key, {
                type: "state",
                common: {
                    name: key,
                    type: "number",
                    role: "value",
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        // Declare inputs
        const inputs = {
            "S01": 6.2, // i.e collector temperature in °C
            "S02": 67.6, // i.e Buffer 1 top temperature in °C
            "S03": 36.1, // i.e Buffer 2 bottom temperature in °C
            "S04": 34.1, // i.e Hot water temperature in °C
            "S05": 24.7, // i.e Solar return primary temperature in °C
            "S06": 41.3, // i.e Solar flow secondary temperature in °C
            "S07": 25.4, // i.e Solar flow primary temperature in °C
            "S08": 67.1, // i.e Buffer 1 top 2 temperature in °C
            "S09": 51.1, // i.e Buffer 1 middle temperature in °C
            "S10": 36.7, // i.e Boiler return temperature in °C
            "S11": 53.3, // i.e Circulation return temperature in °C
            "S12": 7.9, // i.e Outer wall temperature in °C
            "S13": 43.5, // i.e Heating circuit 1 flow temperature in °C
            "S14": 69.1, // i.e Boiler flow temperature in °C
            "S15": 0, // i.e Not used
            "S16": 0 // i.e Solar flow rate in l/h
        };

        for (const key of Object.keys(inputs)) {
            await this.setObjectNotExistsAsync("inputs." + key, {
                type: "state",
                common: {
                    name: key,
                    type: "number",
                    role: "value",
                    unit: units[key], // Set unit based on test read
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        // Declare thermal energy counters status
        const thermalEnergyCountersStatus = {
            "wmz1": "active", // Thermal energy counter 1 status
            "wmz2": "inactive" // Thermal energy counter 2 status
        };

        for (const key of Object.keys(thermalEnergyCountersStatus)) {
            await this.setObjectNotExistsAsync("thermal_energy_counters_status." + key, {
                type: "state",
                common: {
                    name: key,
                    type: "string",
                    role: "indicator",
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        // Declare thermal energy counters
        const thermalEnergyCounters = {
            "current_heat_power1": 0, // Current heat power 1 in kW
            "total_heat_energy1": 61214, // Total heat energy 1 in kWh
            "current_heat_power2": 576768, // Current heat power 2 in kW
            "total_heat_energy2": 771 // Total heat energy 2 in kWh
        };

        for (const key of Object.keys(thermalEnergyCounters)) {
            let unit;
            if (key.startsWith("current_heat_power")) {
                unit = "kW";
            } else if (key.startsWith("total_heat_energy")) {
                unit = "kWh";
            }

            await this.setObjectNotExistsAsync("thermal_energy_counters." + key, {
                type: "state",
                common: {
                    name: key,
                    type: "number",
                    role: "value",
                    unit: unit,
                    read: true,
                    write: false,
                },
                native: {},
            });
        }
        this.log.debug("objects for metrics declared.");
    }

    async sendCommand(command) {
        const sleep = (ms) => {
            return new Promise(resolve => setTimeout(resolve, ms));
        };

        await sleep(2000); // Wait two seconds between commands
        return new Promise((resolve, reject) => {
            const ipAddress = this.config.ip_address; // IP address from the config
            const port = this.config.port; // Port from the config
            const client = new net.Socket();

            client.connect(port, ipAddress, () => {
                client.write(Buffer.from([command]));
            });

            client.on("data", (data) => {
                client.destroy();
                resolve(data);
            });

            client.on("error", (err) => {
                client.destroy();
                reject(err);
            });

            client.on("close", () => {
                reject(new Error("Connection closed unexpectedly"));
            });
        });
    }

    async readDeviceInfo() {
        // Define constants
        const VERSION_REQUEST = 0x81;
        const HEADER_READ = 0xAA;
        const FIRMWARE_REQUEST = 0x82;
        const MODE_REQUEST = 0x21;

        try {
            let data;
            let uvr_mode;
            let uvr_type;
            let uvr2_type;

            // Send version request
            data = await this.sendCommand(VERSION_REQUEST);
            const module_id = data.toString("hex");
            this.log.debug("Received module ID of BL-NET: " + module_id);

            // Query UVR type
            data = await this.fetchDataBlockFromDevice(HEADER_READ);
            // Guess the uvr_modus based on the length of the data array
            const KOPFSATZ_D1_LENGTH = 14;
            const KOPFSATZ_A8_LENGTH = 13;
            const KOPFSATZ_DC_LENGTH = 21;
            //  0xA8 (1DL) / 0xD1 (2DL) / 0xDC (CAN) */
            let uvr_mode_str;
            switch (data.length) {
                case KOPFSATZ_D1_LENGTH:
                    uvr_mode = 0xD1;
                    uvr_mode_str = "2DL";
                    break;
                case KOPFSATZ_A8_LENGTH:
                    uvr_mode = 0xA8;
                    uvr_mode_str = "1DL";
                    break;
                case KOPFSATZ_DC_LENGTH:
                    uvr_mode = 0xDC;
                    uvr_mode_str = "CAN";
                    break;
                default:
                    throw new Error("Unknown data length: " + data.length);
            }
            this.log.debug("Received UVR mode of BL-NET: " + uvr_mode_str);

            // KopfsatzD1 kopf_D1[1];
            // KopfsatzA8 kopf_A8[1];
            // KOPFSATZ_DC kopf_DC[1];



            // Define the offsets based on the C struct definitions
            const HEADER_D1_DEVICE1_LENGTH_OFFSET = 5;
            const HEADER_D1_DEVICE2_LENGTH_OFFSET = 6;
            const HEADER_A8_DEVICE1_LENGTH_OFFSET = 5;

            if (uvr_mode === 0xD1) {
                /* Data structure of the header from D-LOGG or BL-Net */
                /* Mode 0xD1 - Length 14 bytes - KopfsatzD1 - */
                // typedef struct {
                //     UCHAR kennung;
                //     UCHAR version;
                //     UCHAR zeitstempel[3];
                //     UCHAR satzlaengeGeraet1;
                //     UCHAR satzlaengeGeraet2;
                //     UCHAR startadresse[3];
                //     UCHAR endadresse[3];
                //     UCHAR pruefsum;  /* Sum of bytes mod 256 */
                // } KopfsatzD1;
                uvr_type = data[HEADER_D1_DEVICE1_LENGTH_OFFSET]; // 0x5A -> UVR61-3; 0x76 -> UVR1611
                uvr2_type = data[HEADER_D1_DEVICE2_LENGTH_OFFSET]; // 0x5A -> UVR61-3; 0x76 -> UVR1611
            } else {
                /* Data structure of the header from D-LOGG or BL-Net */
                /* Mode 0xA8 - Length 13 bytes - KopfsatzA8 - */
                // typedef struct {
                //     UCHAR kennung;
                //     UCHAR version;
                //     UCHAR zeitstempel[3];
                //     UCHAR satzlaengeGeraet1;
                //     UCHAR startadresse[3];
                //     UCHAR endadresse[3];
                //     UCHAR pruefsum;  /* Sum of bytes mod 256 */
                // } KopfsatzA8;
                uvr_type = data[HEADER_A8_DEVICE1_LENGTH_OFFSET]; // 0x5A -> UVR61-3; 0x76 -> UVR1611
            }

            if (uvr_mode === 0xDC) {
                uvr_type = 0x76; // CAN-Logging only with UVR1611
            }

            // Translate uvr_typ to string
            let uvr_type_str;
            switch (uvr_type) {
                case 0x5A:
                    uvr_type_str = "UVR61-3";
                    break;
                case 0x76:
                    uvr_type_str = "UVR1611";
                    break;
                default:
                    uvr_type_str = "Unknown";
            }
            this.log.debug("Received UVR type of BL-NET: " + uvr_type_str);

            // Translate uvr_typ2 to string if it exists
            let uvr2_type_str;
            if (uvr2_type !== undefined) {
                switch (uvr2_type) {
                    case 0x5A:
                        uvr2_type_str = "UVR61-3";
                        break;
                    case 0x76:
                        uvr2_type_str = "UVR1611";
                        break;
                    default:
                        uvr2_type_str = "Unknown";
                }
                this.log.debug("Received UVR type 2 of BL-NET: " + uvr2_type_str);
            }

            // Send firmware version request
            this.log.debug("Prereading firmware version of BL-NET");
            data = await this.sendCommand(FIRMWARE_REQUEST);
            this.log.debug("Reading firmware version of BL-NET");
            const firmwareVersion = (data.readUInt8(0) / 100).toString();
            this.log.debug("Received firmware version of BL-NET: " + firmwareVersion);

            // Send transmission mode request
            data = await this.sendCommand(MODE_REQUEST);
            const transmission_mode = data.readUInt8(0);
            this.log.debug("Received mode of BL-NET: " + transmission_mode);
            // encode transmission_mode to string
            let transmission_mode_str;
            switch (transmission_mode) {
                // case 0x90:
                //     transmission_mode_str = "Current Data - UVR61-3";
                //     break;
                case 0x80:
                    transmission_mode_str = "Current Data"; //  - UVR1611
                    break;
                default:
                    transmission_mode_str = "Unknown";
            }
            this.log.debug("transmission_mode name: " + transmission_mode_str);

            return {
                uvr_mode: uvr_mode_str,
                uvr_type: uvr_type_str,
                uvr2_type: uvr2_type_str,
                module_id: "0x" + module_id.toUpperCase(),
                firmware_version: firmwareVersion,
                transmission_mode: transmission_mode_str
            };
        } catch (error) {
            this.log.error("Error during communication with device: " + error);
            throw error;
        } finally {
            this.log.debug("End readDeviceInfo");
        }
    }

    /**
     * Fetches state values from the IoT device.
     * @returns {Promise<Object>} - A promise that resolves with the state values.
     */
    async fetchDataBlockFromDevice(command) {
        return new Promise((resolve, reject) => {
            const maxRetries = 5; // Maximum number of retries
            let attempt = 0; // Current attempt

            const attemptFetch = async () => {
                while (attempt < maxRetries) {
                    attempt++;
                    try {
                        const data = await this.sendCommand(command);
                        this.log.debug("Send command: " + command + " as attempt: " + attempt);

                        // Process the received data here
                        this.logHexDump("fetchDataBlockFromDevice", data); // Log hex dump of the data
                        if (data && data.length > 1) {
                            resolve(data); // finalize the Promise value
                            return; // Successfully, exit the loop
                        } else {
                            // ignore the non expected short response
                            this.log.debug("Invalid short response from device");
                            //this.logHexDump(data); // Log hex dump of the data
                            if (attempt >= maxRetries) {
                                reject(new Error("Max retries reached. Unable to communicate with device."));
                            }
                        }
                    } catch (error) {
                        this.log.error("Error during communication with device on attempt " + attempt + ": " + error);
                        if (attempt >= maxRetries) {
                            reject(new Error("Max retries reached. Unable to communicate with device."));
                        }
                    }
                }
            };

            this.log.debug("Initiate attempt to fetch data block from BL-NET");
            attemptFetch(); // Start with the first attempt
        });
    }

    /**
     * Fetches state values from the IoT device.
     * @returns {Promise<Object>} - A promise that resolves with the state values.
     */
    async fetchStateValuesFromDevice() {
        const stateValues = {};
        const READ_CURRENT_DATA = 0xAB; // Command byte to read current data
        try {

            const data = await this.fetchDataBlockFromDevice(READ_CURRENT_DATA);

            // Process the received data here
            // case 0x90: transmission_mode_str = "Current Data - UVR61-3";
            // case 0x80: transmission_mode_str = "Current Data - UVR1611";
            // this.logHexDump(data); // Log hex dump of the data
            if (data[0] === 0x80) {
                // Process the response data
                const response = this.readBlock(data, 57);
                if (response) {
                    // Parse the response and update stateValues
                    const uvrRecord = this.parseUvrRecord(response);
                    if (uvrRecord) {
                        Object.assign(stateValues, uvrRecord);
                    }
                    this.log.debug("fetchStateValuesFromDevice successful.");
                    return stateValues; // Return the state values
                } else {
                    this.log.debug("Invalid response from device");
                    this.log.debug("Unexpected data format");
                    throw new Error("Invalid response from device");
                }
            } else {
                // ignore the non expected response
                this.log.debug("Unexpected data format");
                this.logHexDump("fetchStateValuesFromDevice", data); // Log hex dump of the data;
                throw new Error("Unexpected data format");
            }
        } catch (error) {
            this.log.error("Error during communication with device on attempt: " + error);
        }
    }

    /**
     * Reads a block of data of the specified length from the given data array.
     *
     * @param {Uint8Array} data - The data array to read from.
     * @param {number} length - The length of the block to read.
     * @returns {Uint8Array|null} The block of data if the length is sufficient, otherwise null.
     */
    readBlock(data, length) {
        if (data.length >= length) {
            const block = data.slice(0, length);
            //this.logHexDump(block);
            return block;
        }
        return null;
    }

    /**
     * Logs a hexadecimal dump of the provided data.
     *
     * @param {Uint8Array} data - The data to be converted to a hexadecimal string and logged.
     */
    logHexDump(message, data) {
        let hexString = "";
        if (data) {
            for (let i = 0; i < data.length; i++) {
                hexString += data[i].toString(16).padStart(2, "0") + " ";
                if ((i + 1) % 16 === 0) {
                    hexString += "\n";
                }
            }
            this.log.debug(message + " - hex dump:\n" + hexString);
        } else {
            this.log.debug("no data to dump");
        }
    }

    /**
     * Parses the UVR record from the given response.
     *
     * @param {Uint8Array} response - The response data to parse.
     * @returns {Object} The parsed UVR record.
     * @property {Object} outputs - The outputs status.
     * @property {Object} speed_levels - The speed levels.
     * @property {Object} inputs - The inputs.
     * @property {Object} thermal_energy_counters_status - The status of thermal energy counters.
     * @property {Object} thermal_energy_counters - The thermal energy counters.
     */
    parseUvrRecord(response) {
        const uvrRecord = {
            outputs: {},
            speed_levels: {},
            inputs: {},
            thermal_energy_counters_status: {},
            thermal_energy_counters: {}
        };

        // Example parsing logic based on UvrRecord.java
        // Outputs
        const output = this.byte2short(response[33], response[34]);
        uvrRecord.outputs["A01"] = (output & 0x01) ? "ON" : "OFF";
        uvrRecord.outputs["A02"] = (output & 0x02) ? "ON" : "OFF";
        uvrRecord.outputs["A03"] = (output & 0x04) ? "ON" : "OFF";
        uvrRecord.outputs["A04"] = (output & 0x08) ? "ON" : "OFF";
        uvrRecord.outputs["A05"] = (output & 0x10) ? "ON" : "OFF";
        uvrRecord.outputs["A06"] = (output & 0x20) ? "ON" : "OFF";
        uvrRecord.outputs["A07"] = (output & 0x40) ? "ON" : "OFF";
        uvrRecord.outputs["A08"] = (output & 0x80) ? "ON" : "OFF";
        uvrRecord.outputs["A09"] = (output & 0x100) ? "ON" : "OFF";
        uvrRecord.outputs["A10"] = (output & 0x200) ? "ON" : "OFF";
        uvrRecord.outputs["A11"] = (output & 0x400) ? "ON" : "OFF";
        uvrRecord.outputs["A12"] = (output & 0x800) ? "ON" : "OFF";
        uvrRecord.outputs["A13"] = (output & 0x1000) ? "ON" : "OFF";

        // Log outputs
        this.log.debug("Outputs: " + JSON.stringify(uvrRecord.outputs));

        // Speed levels
        uvrRecord.speed_levels["DzA1"] = response[35];
        uvrRecord.speed_levels["DzA2"] = response[36];
        uvrRecord.speed_levels["DzA6"] = response[37];
        uvrRecord.speed_levels["DzA7"] = response[38];

        // Log speed levels
        this.log.debug("Speed levels: " + JSON.stringify(uvrRecord.speed_levels));

        // Inputs
        for (let i = 0; i < 16; i++) {
            uvrRecord.inputs["S" + (i + 1).toString().padStart(2, "0")] = this.byte2short(response[i * 2 + 1], response[i * 2 + 2]);
        }

        // Log inputs
        this.log.debug("Inputs: " + JSON.stringify(uvrRecord.inputs));

        // Thermal energy counters status
        const wmz = response[39];
        uvrRecord.thermal_energy_counters_status["wmz1"] = (wmz & 0x1) ? "active" : "inactive";
        uvrRecord.thermal_energy_counters_status["wmz2"] = (wmz & 0x2) ? "active" : "inactive";

        // Log thermal energy counters status
        this.log.debug("Thermal energy counters status: " + JSON.stringify(uvrRecord.thermal_energy_counters_status));

        // Thermal energy counters
        if (wmz & 0x1) {
            const lowLow1 = response[40];
            const lowHigh1 = response[41];
            const highLow1 = response[42];
            const highHigh1 = response[43];

            const hundredths1 = (lowLow1 * 10) / 256;
            let power1 = (10 * this.byte2int(lowHigh1, highLow1, highHigh1, 0) + hundredths1) / 100;

            // Check for negative sign bit
            if (highHigh1 > 32767) {
                power1 = (10 * (this.byte2int(lowHigh1, highLow1, highHigh1, 0) - 65536) - hundredths1) / 100;
            }

            uvrRecord.thermal_energy_counters["current_heat_power1"] = power1;
            uvrRecord.thermal_energy_counters["total_heat_energy1"] = this.byte2short(response[44], response[45]) / 10.0 + // kWh
                this.byte2short(response[46], response[47]) * 1000.0; // MWh
        } else {
            uvrRecord.thermal_energy_counters["current_heat_power1"] = 0;
            uvrRecord.thermal_energy_counters["total_heat_energy1"] = 0;
        }

        if (wmz & 0x2) {
            const lowLow2 = response[48];
            const lowHigh2 = response[49];
            const highLow2 = response[50];
            const highHigh2 = response[51];

            const hundredths2 = (lowLow2 * 10) / 256;
            let power2 = (10 * this.byte2int(lowHigh2, highLow2, highHigh2, 0) + hundredths2) / 100;

            // Check for negative sign bit
            if (highHigh2 > 32767) {
                power2 = (10 * (this.byte2int(lowHigh2, highLow2, highHigh2, 0) - 65536) - hundredths2) / 100;
            }

            uvrRecord.thermal_energy_counters["current_heat_power2"] = power2;
            uvrRecord.thermal_energy_counters["total_heat_energy2"] = this.byte2short(response[52], response[53]) / 10.0 + // kWh
                this.byte2short(response[54], response[55]) * 1000.0; // MWh
        } else {
            uvrRecord.thermal_energy_counters["current_heat_power2"] = 0;
            uvrRecord.thermal_energy_counters["total_heat_energy2"] = 0;
        }
        // Log thermal energy counters
        this.log.debug("Thermal energy counters: " + JSON.stringify(uvrRecord.thermal_energy_counters));

        return uvrRecord;
    }

    /**
     * Converts two bytes into a short integer.
     *
     * @param {number} lo - The low byte.
     * @param {number} hi - The high byte.
     * @returns {number} The resulting short integer.
     */
    byte2short(lo, hi) {
        return (hi << 8) | (lo & 0xFF);
    }

    /**
     * Converts four bytes into a 32-bit integer.
     *
     * @param {number} lo_lo - The least significant byte.
     * @param {number} lo_hi - The second least significant byte.
     * @param {number} hi_lo - The third least significant byte.
     * @param {number} hi_hi - The most significant byte.
     * @returns {number} The 32-bit integer formed by the four bytes.
     */
    byte2int(lo_lo, lo_hi, hi_lo, hi_hi) {
        return (this.byte2short(lo_lo, lo_hi) & 0xFFFF) | (this.byte2short(hi_lo, hi_hi) << 16);
    }

    /**
     * Cleans up resources when the adapter is unloaded.
     *
     * @param {Function} callback - The callback function to call after cleanup.
     * @throws Will call the callback function in case of an error.
     */
    onUnload(callback) {
        try {
            // Clear the polling interval
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
            }
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);

            callback();
        } catch (e) {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // onObjectChange(id, obj) {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Handles changes to subscribed states.
     * @param {string} id - The ID of the state that changed.
     * @param {ioBroker.State | null | undefined} state - The new state value or null if the state was deleted.
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info("state " + id + " changed: " + state.val + " (ack = " + state.ack + ")");
        } else {
            // The state was deleted
            this.log.info("state " + id + " deleted");
        }
    }


    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === "object" && obj.message) {
    //         if (obj.command === "send") {
    //             // e.g. send email or pushover or whatever
    //             this.log.info("send command");

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
    //         }
    //     }
    // }

}

// Check if the script is being run directly or required as a module
if (require.main !== module) {
    // Export the constructor in compact mode for use as a module
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Uvr16xxBlNet(options);
} else {
    // Otherwise, start the instance directly when run as a standalone script
    new Uvr16xxBlNet();
}