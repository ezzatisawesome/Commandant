import { redirect } from "next/navigation";

// Commandant is a flight/ops UI first; the satellite view lives at /satellites.
export default function Home() {
	redirect("/flight");
}
