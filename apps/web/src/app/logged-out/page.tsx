import Image from "next/image";
import Link from "next/link";

export default function LoggedOutPage() {
  return (
    <main className="centered-state">
      <Image src="/bdr_logo_name.png" alt="Building Diagnostic Robotics" width={170} height={98} priority />
      <h1>You’re signed out</h1>
      <p>Your BDR Inspections Dashboard session has ended.</p>
      <Link className="button button--primary" href="/projects">Sign in again</Link>
    </main>
  );
}
