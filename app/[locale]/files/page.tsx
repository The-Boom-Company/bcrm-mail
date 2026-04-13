"use client";

import { useRouter } from "@/i18n/navigation";
import { useEffect } from "react";

export default function FilesPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return null;
}
