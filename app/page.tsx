'use client';

import { useState } from 'react';
import Call from '@/components/Call';
import Lobby from '@/components/Lobby';
import type { DocText, Interviewer } from '@/lib/types';

export default function Home() {
  const [documents, setDocuments] = useState<DocText[]>([]);
  const [interviewer, setInterviewer] = useState<Interviewer>('hiring-manager');
  const [inCall, setInCall] = useState(false);

  return (
    <main className="flex min-h-screen flex-col justify-center px-4 py-8 sm:py-12">
      {inCall ? (
        <Call documents={documents} interviewer={interviewer} onEnd={() => setInCall(false)} />
      ) : (
        <Lobby
          documents={documents}
          setDocuments={setDocuments}
          interviewer={interviewer}
          setInterviewer={setInterviewer}
          onStart={() => setInCall(true)}
        />
      )}
    </main>
  );
}
