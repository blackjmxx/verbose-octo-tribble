import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-center font-mono text-sm flex flex-col">
        <h1 className="text-4xl font-bold mb-8">Code Sandbox Service</h1>
        <p className="text-xl mb-8">
          Exécutez votre code dans un environnement isolé et sécurisé
        </p>

        <div className="flex gap-4">
          <Link href="/login">
            <Button size="lg">Se connecter</Button>
          </Link>
          <Link href="/register">
            <Button variant="outline" size="lg">
              S&apos;inscrire
            </Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
