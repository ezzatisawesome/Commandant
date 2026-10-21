import { atom } from "nanostores";

/** True while the frames arriving describe a RECORDED flight, not a live one.
 *
 *  gs marks every frame of a replay rather than announcing it once, so a
 *  console that reloads or joins halfway through still knows. The console's job
 *  is to make that impossible to miss: every instrument on screen is showing
 *  real numbers from a real flight, which is exactly what makes a replay
 *  dangerous to mistake for the present. */
export const $replay = atom(false);
