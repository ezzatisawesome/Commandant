import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import { Cartesian3, JulianDate, CallbackProperty, Color, Math as CesiumMath, HeightReference } from "cesium";

import { Satellite } from "@/services/Satellite";
import { $viewerStore } from "@/stores/cesium.store";
import { $timeStore } from "@/stores/states.store";
import { getOrbitById } from "@/stores/orbit.store";

interface ISatelliteProps {
    id: string;
}

export default function Satellites(props: ISatelliteProps) {
    const $viewer = useStore($viewerStore);
    const $time = useStore($timeStore);
    const satelliteRef = useRef<Satellite>(); // Ref to store the Satellite instance

    const getCartesian = (pos: number[]) => {
        const [x, y, z] = pos;
        return Cartesian3.fromElements(x * 1000, y * 1000, z * 1000);
    }

    useEffect(() => {
        const orbit = getOrbitById(props.id);
        if (orbit) {
            const params = {
                semiMajorAxis: orbit.semiMajorAxis,
                eccentricity: orbit.eccentricity,
                inclination: orbit.inclination,
                longitudeAscendingNode: orbit.longitudeAscendingNode,
                argumentOfPeriapses: orbit.argumentOfPeriapses,
                trueAnomaly: orbit.trueAnomaly
            }
            satelliteRef.current = new Satellite(props.id, params);
            satelliteRef.current.init();
        }
    }, [])

    useEffect(() => {
        const sat = satelliteRef.current;
        if ($viewer && sat) {
            const t0 = JulianDate.toDate($time).getTime() / 1000; // Initial start time in seconds

            $viewer.entities.add({
                polyline: {
                    positions: new CallbackProperty((time) => {
                        if (!time) return [];
                        const statesLen = sat.states.length;
                        const nStatesLen = sat.nStates.length;
                        const period = sat.orbitalPeriod;

                        const currentTime = JulianDate.toDate(time).getTime() / 1000;
                        const stateIndex = Math.floor((currentTime - t0) / period) * period;

                        // Add in a Cesium sphere entity to represent the satellite
                        $viewer.entities.add({
                            point: {
                                pixelSize: 5,
                                color: Color.RED, // Satellite color
                            }
                        });


                        if (stateIndex + period > statesLen && statesLen !== 0) {
                            sat.propagate(true);
                        } else if (Math.abs(stateIndex) + period > nStatesLen && nStatesLen !== 0) {
                            sat.propagate(true, true);
                        }

                        if (stateIndex >= 0) {
                            return sat.states
                                .slice(stateIndex, stateIndex + period)
                                .map(s => getCartesian(s));
                        } else if (stateIndex < 0 && stateIndex >= -period) {
                            const arr = [];

                            arr.push(...sat.states
                                .slice(0, stateIndex + period)
                                .map(s => getCartesian(s)))

                            arr.push(...sat.nStates
                                .slice(0, Math.abs(stateIndex))
                                .map(s => getCartesian(s)))

                            return arr
                        } else {
                            return sat.nStates
                                .slice(Math.abs(stateIndex) - period, Math.abs(stateIndex))
                                .map(s => getCartesian(s));
                        }
                    }, false),
                    width: 2,
                    material: Color.CYAN, // Orbit track color
                }
            });

            // Add a sphere for the satellite location
            $viewer.entities.add({
                position: new CallbackProperty((time) => {
                    if (!time) return Cartesian3.ZERO;

                    const currentTime = JulianDate.toDate(time).getTime() / 1000;
                    const stateIndex = Math.floor(currentTime - t0);

                    if (stateIndex >= 0 && stateIndex < sat.states.length) {
                        return getCartesian(sat.states[stateIndex]);
                    } else if (stateIndex < 0 && Math.abs(stateIndex) < sat.nStates.length) {
                        return getCartesian(sat.nStates[Math.abs(stateIndex)]);
                    }

                    return Cartesian3.ZERO;
                }, false),
                point: {
                    pixelSize: 4,
                    color: Color.GHOSTWHITE
                },
                cylinder: {
                    length: new CallbackProperty((time) => {
                        if (!time) return 0;

                        // Dynamically calculate length based on altitude
                        const currentTime = JulianDate.toDate(time).getTime() / 1000;
                        const stateIndex = Math.floor(currentTime - t0);
                        
                        let cartesianPos;

                        if (stateIndex >= 0 && stateIndex < sat.states.length) {
                            cartesianPos = getCartesian(sat.states[stateIndex]);
                        } else if (stateIndex < 0 && Math.abs(stateIndex) < sat.nStates.length) {
                            cartesianPos = getCartesian(sat.nStates[Math.abs(stateIndex)]);
                        } else {
                            cartesianPos = Cartesian3.ZERO;
                        }

                        const altitude = Cartesian3.magnitude(cartesianPos) - 6371000; // Get magnitude from Cartesian
                        return altitude; // Set the length of the cone to the altitude
                    }, false),
                    topRadius: 0.0,   // Top radius of the cone (0 for a sharp tip)
                    bottomRadius: 200000.0, // Bottom radius (defines the spread of the cone)
                    material: Color.RED.withAlpha(0.3), // Cone color with transparency
                    heightReference: HeightReference.CLAMP_TO_GROUND, // No height clamping
                },
            });
        }
    }, [satelliteRef.current?.states])

    return null;
}