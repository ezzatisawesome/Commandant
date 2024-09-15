export interface ClassicalOrbitalElements {
    semiMajorAxis: number,
    eccentricity: number,
    inclination: number,
    longitudeAscendingNode: number,
    argumentOfPeriapses: number,
    trueAnomaly: number,
}

export interface Satellite extends ClassicalOrbitalElements {
    _id: string,
    name: string
}

export interface StateElements {
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
}