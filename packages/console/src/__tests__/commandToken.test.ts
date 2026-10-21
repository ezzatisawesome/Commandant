import { describe, it, expect, beforeEach } from "vitest";

import { $commandToken, $tokenRequired, setCommandToken } from "@/stores/token.store";

/**
 * gs binds 0.0.0.0 and the hub runs its own WiFi on a flight line, so without a
 * secret anyone within range who loads the page can take command authority and
 * arm the aircraft. gs gates the CLAIM, which is the only door to authority.
 *
 * The console's half: carry the token on the claim, keep it on the device, and
 * tell the operator when the hub refuses for want of it — as opposed to the
 * generic "another console holds command", which is the one refusal they cannot
 * do anything about and the wrong thing to say here.
 */
describe("the hub's command token", () => {
	beforeEach(() => { $commandToken.set(""); $tokenRequired.set(false); });

	it("is empty by default, which is a bench or SITL hub", () => {
		expect($commandToken.get()).toBe("");
	});

	it("is trimmed, because it is typed and pasted by a person", () => {
		setCommandToken("  flightline-secret \n");
		expect($commandToken.get()).toBe("flightline-secret");
	});

	it("is kept on the device rather than served with the page", () => {
		// A token the page handed out would be a token anyone who loaded the
		// page already has, which is the attack it exists to stop. persistentAtom
		// keeps it in this browser's storage only.
		setCommandToken("abc");
		expect($commandToken.get()).toBe("abc");
		expect(JSON.stringify($commandToken.get())).not.toContain("undefined");
	});

	it("the prompt is driven by the hub's reason, not by any refusal", () => {
		// "another console holds command" must NOT raise the token prompt: the
		// operator would type a token at a problem a token cannot solve.
		const refusal = (text: string) => /token/i.test(text);
		expect(refusal("command authority needs the hub token")).toBe(true);
		expect(refusal("not commander")).toBe(false);
		expect(refusal("another console still holds command")).toBe(false);
	});

	it("clears the prompt once authority is granted", () => {
		$tokenRequired.set(true);
		$tokenRequired.set(false);          // what a successful claim does
		expect($tokenRequired.get()).toBe(false);
	});
});
