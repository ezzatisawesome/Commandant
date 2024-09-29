import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import { Cartesian3, JulianDate, CallbackProperty, Color, HeightReference } from "cesium";

import { Satellite } from "@/services/Satellite";
import { $viewerStore } from "@/stores/cesium.store";
import { $timeStore } from "@/stores/states.store";
import { getSatById } from "@/stores/sat.store";

interface ISatelliteProps {
    id: string;
}

export default function Satellites(props: ISatelliteProps) {
    const $viewer = useStore($viewerStore);
    const $time = useStore($timeStore);
    const satelliteRef = useRef<Satellite>(); // Ref to store the Satellite instance
    const entitiesRef = useRef<string[]>([]);
    const sat = getSatById(props.id);

    const getCartesian = (pos: number[]) => {
        const [x, y, z] = pos;
        return Cartesian3.fromElements(x * 1000, y * 1000, z * 1000);
    };

    useEffect(() => {
        if (!sat) return;

        const params = {
            semiMajorAxis: sat.semiMajorAxis,
            eccentricity: sat.eccentricity,
            inclination: sat.inclination,
            longitudeAscendingNode: sat.longitudeAscendingNode,
            argumentOfPeriapses: sat.argumentOfPeriapses,
            trueAnomaly: sat.trueAnomaly
        };

        // Create a new Satellite instance and initialize it
        satelliteRef.current = new Satellite(props.id, params, sat.sensorRadius);
        satelliteRef.current.init();
    }, [sat]);

    useEffect(() => {
        const sat = satelliteRef.current;

        if ($viewer && sat) {
            // Remove existing entities
            entitiesRef.current.forEach(id => $viewer.entities.removeById(id));

            const t0 = JulianDate.toDate($time).getTime() / 1000; // Initial start time in seconds

            // Add polyline entity for the satellite's orbit
            const polylineEntity = $viewer.entities.add({
                polyline: {
                    positions: new CallbackProperty((time) => {
                        if (!time) return [];
                        const statesLen = sat.states.length;
                        const nStatesLen = sat.nStates.length;
                        const period = sat.orbitalPeriod;

                        const currentTime = JulianDate.toDate(time).getTime() / 1000;
                        const stateIndex = Math.floor(currentTime - t0);
                        const incrementedIndex = Math.floor((currentTime - t0) / period) * period;

                        if (stateIndex + 0.25*period > statesLen && statesLen !== 0) {
                            sat.propagate(true);
                        } else if (Math.abs(stateIndex) + 0.25*period > nStatesLen && nStatesLen !== 0) {
                            sat.propagate(true, true);
                        }

                        if (stateIndex >= 0) {
                            return sat.states
                                .slice(incrementedIndex, incrementedIndex + period)
                                .map(s => getCartesian(s));
                        } else if (stateIndex < 0 && stateIndex >= -period) {
                            const arr = [];

                            arr.push(...sat.states
                                .slice(0, incrementedIndex + period)
                                .map(s => getCartesian(s)));

                            arr.push(...sat.nStates
                                .slice(0, Math.abs(incrementedIndex))
                                .map(s => getCartesian(s)));

                            return arr;
                        } else {
                            return sat.nStates
                                .slice(Math.abs(incrementedIndex) - period, Math.abs(incrementedIndex))
                                .map(s => getCartesian(s));
                        }
                    }, false),
                    width: 2,
                    material: Color.CYAN, // Orbit track color
                }
            });

            polylineEntity.id

            // Add point entity for the satellite's current position
            const positionEntity = $viewer.entities.add({
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
                cylinder: sat.sensorRadius ? {
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

                        return Cartesian3.magnitude(cartesianPos) - 6371000;
                    }, false),
                    topRadius: 0.0, // Top radius of the cone (0 for a sharp tip)
                    bottomRadius: sat.sensorRadius, // Bottom radius (defines the spread of the cone)
                    material: Color.RED.withAlpha(0.3), // Cone color with transparency
                    heightReference: HeightReference.CLAMP_TO_GROUND, // No height clamping
                } : undefined,
            });

            entitiesRef.current = [polylineEntity.id, positionEntity.id];
        }
    }, [sat, satelliteRef.current?.states]);

    return null;
}
