const oe = require('obj-ease');

module.exports = function (RED) {

    class ZigbeeHue {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.shepherdNode = shepherdNode;
            this.devices = shepherdNode.devices;
            this.shepherd = shepherdNode.shepherd;
            this.proxy = shepherdNode.proxy;

            let nodeStatus;
            shepherdNode.proxy.on('nodeStatus', status => {
                nodeStatus = status;
                this.status(status);
            });

            this.lights = shepherdNode.lights;

            this.lightsInternal = shepherdNode.lightsInternal;


            const indHandler = msg => {
                let ieeeAddr;
                let index;

                switch (msg.type) {
                    case 'devIncoming':
                        console.log('devIncoming', shepherdNode.getLightIndex(msg.data));
                        console.log(msg);
                        break;
                    case 'devChange':
                    case 'devStatus':
                        ieeeAddr = msg.endpoints && msg.endpoints[0] && msg.endpoints[0].device && msg.endpoints[0].device.ieeeAddr;
                        index = shepherdNode.getLightIndex(ieeeAddr);
                        if (!index) {
                            return;
                        }

                        console.log(msg.type, index);
                        const ziee = msg.endpoints[0].clusters;

                        const state = {
                            on: Boolean(ziee.genOnOff.attrs.onOff)
                        };

                        if (msg.type === 'devStatus') {
                            state.reachable = msg.data === 'online';
                            this.updateLight(index, {swversion: ziee.genBasic.attrs.swBuildId});
                        }
                        //console.log('clusters', msg.endpoints[0].clusters);

                        if (ziee.genLevelCtrl) {
                            state.bri = ziee.genLevelCtrl.attrs.currentLevel;
                        }

                        if (ziee.lightingColorCtrl) {
                            const {attrs} = ziee.lightingColorCtrl;
                            if (typeof attrs.colorTemperature !== 'undefined') {
                                state.ct = attrs.colorTemperature;
                            }

                            if (typeof attrs.enhancedCurrentHue !== 'undefined') {
                                state.hue = attrs.enhancedCurrentHue;
                            }

                            if (typeof attrs.currentSaturation !== 'undefined') {
                                state.sat = attrs.currentSaturation;
                            }

                            if (typeof attrs.currentX !== 'undefined') {
                                state.xy = [attrs.currentX, attrs.currentY];
                            }

                            if (typeof attrs.currentSaturation !== 'undefined') {
                                state.sat = attrs.currentSaturation;
                            }

                            if (typeof attrs.colorMode !== 'undefined') {
                                switch (attrs.colorMode) {
                                    case 0:
                                        state.colormode = 'hs';
                                        break;
                                    case 1:
                                        state.colormode = 'xy';
                                        break;
                                    case 2:
                                        state.colormode = 'ct';
                                        break;
                                    default:
                                }
                            }
                        }

                        this.updateLightState(index, state);
                        break;

                    case 'devInterview':
                        index = shepherdNode.getLightIndex(msg.data);
                        if (!index) {
                            return;
                        }

                        console.log('devInterview', index);
                        break;
                    case 'attReport':
                        ieeeAddr = msg.endpoints && msg.endpoints[0] && msg.endpoints[0].device && msg.endpoints[0].device.ieeeAddr;
                        index = shepherdNode.getLightIndex(ieeeAddr);
                        if (!index) {
                            return;
                        }

                        console.log('attReport', msg);
                        break;
                }
            };

            this.proxy.on('ind', indHandler);

            this.on('close', () => {
                this.proxy.removeListener('ind', indHandler);
            });

            this.on('input', msg => {
                console.log('input!');
                let match;
                if (msg.topic.match(/lights$/)) {
                    this.send(Object.assign(RED.util.cloneMessage(msg), {payload: this.lights}));
                } else if (match = msg.topic.match(/lights\/([^\/]+)$/)) {
                    const [, index] = match;
                    const id = shepherdNode.getLightIndex(index);
                    if (id) {
                        this.send(Object.assign(RED.util.cloneMessage(msg), {payload: this.lights[index]}));
                    } else {
                        this.send(Object.assign(RED.util.cloneMessage(msg), {payload: this.apiError(3, {resource: '/lights/' + index})}));
                    }
                } else if (match = msg.topic.match(/lights\/([^\/]+)\/state$/)) {
                    const [, index] = match;
                    this.putLightsState(msg);
                }
            });
        }

        apiError(id, data) {
            switch (id) {
                case 3:
                    return [
                        {
                            error: {
                                type: 3,
                                address: data.resource,
                                description: 'resource, ' + data.resource + ', not available'
                            }
                        }
                    ];
                default:
            }
        }



        updateLight(lightIndex, data) {
            Object.assign(this.lights[lightIndex], data);
        }

        updateLightState(lightIndex, data) {
            if (oe.extend(this.lights[lightIndex].state, data)) {
                this.send([null, {topic: '/lights/' + (this.lights[lightIndex].name || lightIndex), payload: this.lights[lightIndex].state}]);
            }
        }

        handleCommandCallback(err, res, lightIndex, msg, attributes) {
            if (err) {
                this.error(err.message);
                if (err.message.includes('status code: 233')) {
                    this.updateLight(lightIndex, {reachable: false});
                }
            } else if (msg.payload.transitiontime) {
                //     if (msg.payload.transitiontime > getStateTimeout) {
                //         getStateTimeout = msg.payload.transitiontime;
                //         getStateClusters['genOnOff'] = ['onOff'];
                //     }
            }
        }

        getLights() {

        }

        putLightsState(msg) {
            console.log('putLightsState', msg);
            // xy > ct > hs
            // on bool
            // bri uint8 1-254
            // hue uint16 0-65535
            // sat uint8 0-254
            // xy [float,float] 0-1
            // ct uint16 153-500
            // alert string "none", "select", "lselect"
            // effect string "none" "colorloop"
            // transitiontime uint16
            // bri_inc -254-254
            // sat_inc -254-254
            // hue_inc -65534-65534
            // ct_inc -65534-65534
            // xy_inc [] 0.5 0.5

            const lightIndex = msg.topic.match(/lights\/(\d+)\/state/)[1];

            console.log(lightIndex, this.lightsInternal)

            const dev = this.devices[this.lightsInternal[lightIndex].ieeeAddr];

            const cmds = [];

            const getStateTimeout = 0;
            const getStateClusters = {};

            if (typeof msg.payload.on !== 'undefined' && (msg.payload.on === false || typeof msg.payload.bri === 'undefined')) {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'genOnOff',
                    cmd: msg.payload.on ? 'on' : 'off',
                    zclData: {},
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, ['on']);
                    }
                });
            }

            if (typeof msg.payload.bri !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'genLevelCtrl',
                    // Todo: clarify - bri 1 sets off?
                    cmd: msg.payload.on === true && msg.payload.bri > 1 ? 'moveToLevelWithOnOff' : 'moveToLevel',
                    zclData: {
                        level: msg.payload.bri,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, ['on', 'bri']);
                    }
                });
            } else if (typeof msg.payload.bri_inc !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'genLevelCtrl',
                    cmd: 'step',
                    zclData: {
                        // Todo clarify stepmode values expected by shepherd.
                        // Spec defines up=0x01 down=0x03, shepherd seems to use up=false down=true ?
                        stepmode: msg.payload.bri_inc < 0,
                        stepsize: Math.abs(msg.payload.bri_inc),
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, []);
                    }
                });
            }

            if (typeof msg.payload.xy !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'moveToColor',
                    zclData: {
                        // Todo convert values
                        colorx: msg.payload.xy[0],
                        colory: msg.payload.xy[1],
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, ['xy']);
                    }
                });
            } else if (typeof msg.payload.xy_inc !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'stepColor',
                    zclData: {
                        // Todo convert values
                        stepx: msg.payload.xy_inc[0],
                        stepy: msg.payload.xy_inc[1],
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, []);
                    }
                });
            } else if (typeof msg.payload.ct !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'moveToColorTemp',
                    zclData: {
                        colortemp: msg.payload.ct,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, ['ct']);
                    }
                });
            } else if (typeof msg.payload.ct_inc !== 'undefined') {
                // Todo - clarify: it seems there is no stepColorTemperature cmd - need to know the current ct value?
            } else if (typeof msg.payload.hue !== 'undefined' && typeof msg.payload.sat !== 'undefined') {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'enhancedMoveToHueAndSaturation',
                    zclData: {
                        enhancehue: msg.payload.hue,
                        saturation: msg.payload.sat,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, ['hue', 'sat']);
                    }
                });
            } else if (typeof msg.payload.hue === 'undefined') {
                if (typeof msg.payload.sat !== 'undefined') {
                    cmds.push({
                        ieeeAddr: dev.ieeeAddr,
                        ep: dev.epList[0],
                        cmdType: 'functional',
                        cid: 'lightingColorCtrl',
                        cmd: 'moveToSaturation',
                        zclData: {
                            saturation: msg.payload.sat,
                            transtime: msg.payload.transitiontime || 0
                        },
                        cfg: {
                            disDefaultRsp: 0
                        },
                        disBlockQueue: true,
                        callback: (err, res) => {
                            this.handleCommandCallback(err, res, lightIndex, msg, ['on']);
                        }
                    });
                } else if (typeof msg.payload.hue_inc !== 'undefined' && typeof msg.payload.sat_inc !== 'undefined') {
                    // TODO
                } else if (typeof msg.payload.hue_inc !== 'undefined') {
                    // TODO
                } else if (typeof msg.payload.sat_inc !== 'undefined') {
                    // TODO
                }
            } else {
                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'lightingColorCtrl',
                    cmd: 'enhancedMoveToHue',
                    zclData: {
                        enhancehue: msg.payload.hue,
                        transtime: msg.payload.transitiontime || 0
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, ['hue']);
                    }
                });
            }

            if (typeof msg.payload.alert === 'undefined') {
            } else {
                let effectid;
                let val = msg.payload.alert;
                switch (val) {
                    case 'select':
                        effectid = 0;
                        break;
                    case 'lselect':
                        effectid = 1;
                        break;
                    default:
                        val = 'none';
                        effectid = 255;
                }

                cmds.push({
                    ieeeAddr: dev.ieeeAddr,
                    ep: dev.epList[0],
                    cmdType: 'functional',
                    cid: 'genIdentify',
                    cmd: 'triggerEffect',
                    zclData: {
                        effectid,
                        effectvariant: 1
                    },
                    cfg: {
                        disDefaultRsp: 0
                    },
                    disBlockQueue: true,
                    callback: (err, res) => {
                        this.handleCommandCallback(err, res, lightIndex, msg, []);
                    }
                });
            }

            if (typeof msg.payload.effect !== 'undefined') {
                // TODO
            }

            cmds.forEach(cmd => {
                this.proxy.queue(cmd);
            });
        }
        topicReplace(topic, msg) {
            if (!topic || typeof msg !== 'object') {
                return topic;
            }

            const msgLower = {};
            Object.keys(msg).forEach(k => {
                msgLower[k.toLowerCase()] = msg[k];
            });

            const match = topic.match(/\${[^}]+}/g);
            if (match) {
                match.forEach(v => {
                    const key = v.substr(2, v.length - 3);
                    const rx = new RegExp('\\${' + key + '}', 'g');
                    const rkey = key.toLowerCase();
                    topic = topic.replace(rx, msgLower[rkey] || '');
                });
            }

            return topic;
        }
    }

    RED.nodes.registerType('zigbee-hue', ZigbeeHue);
};
