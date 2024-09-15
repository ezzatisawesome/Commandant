import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import { CallbackProperty, Cartesian3, Color, JulianDate } from "cesium";

import { Satellite } from "@/services/Satellite";
import { $viewerStore } from "@/stores/cesium.store";
import { $timeStore } from "@/stores/states.store";
import { $statesStore } from "@/stores/states.store";
import { getSatelliteById } from "@/stores/satellite.store";

interface ISatelliteProps {
    id: string;
}

export default function Satellites(props: ISatelliteProps) {
    const $viewer = useStore($viewerStore);
    const $states = useStore($statesStore);
    const state = $states[props.id]
    const $time = useStore($timeStore);

    const stateRef = useRef<number>(0);
	const satelliteRef = useRef<Satellite>(); // Ref to store the Satellite instance

    const sat = getSatelliteById(props.id);

    useEffect(() => {
        if (sat) {
            const params = {
                semiMajorAxis: sat.semiMajorAxis,
                eccentricity: sat.eccentricity,
                inclination: sat.inclination,
                longitudeAscendingNode: sat.longitudeAscendingNode,
                argumentOfPeriapses: sat.argumentOfPeriapses,
                trueAnomaly: sat.trueAnomaly
            }
            satelliteRef.current = new Satellite(props.id, params);
            satelliteRef.current.init();
        }

    }, [])


    useEffect(() => {
        if ($viewer && state) {
            const t0 = JulianDate.toDate($time).getTime() / 1000; // Initial start time in seconds
            $viewer.entities.add({
                polyline: {
					positions: new CallbackProperty((time, result) => {
						const currentTime = JulianDate.toDate(time).getTime() / 1000;
						const stateIndex = Math.floor(currentTime - t0);

                        // Update the state index
                        stateRef.current = stateIndex;

                        if (stateIndex + 500 > state.length && state.length !== 0) {
                            console.log('propagating')
                            satelliteRef.current?.propagate(true);
                        } else {
                            console.log('not propagating')
                        }

                        // console.log(state.slice(stateRef.current, stateRef.current + 500))

						const slicedStates = state.slice(stateRef.current, stateRef.current + 500).map((s) => {
                            // console.log(s)
							return Cartesian3.fromElements(s[0] * 1000, s[1] * 1000, s[2] * 1000);
						});


						return slicedStates;
					}, false),
					width: 2,
					material: Color.CYAN, // Orbit track color
				}
            })
        }
    }, [$states])

    return (
        <></>
    )
}