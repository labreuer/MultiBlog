import EnterCodeForm from "./enter-code-form";

// docs/EMAIL.md §10, "The code" — a card's code typed rather than scanned:
// the card prints `<host>/join` under its QR. The form only normalizes the
// code and goes to its card's page, which looks it up.
export default function JoinPage() {
  return <EnterCodeForm />;
}
