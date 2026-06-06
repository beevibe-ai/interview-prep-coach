'use client';

import { useState } from 'react';
import Call from '@/components/Call';
import CoBrowseTeacher from '@/components/CoBrowseTeacher';
import Lobby from '@/components/Lobby';
import type { DocText, Interviewer } from '@/lib/types';

type Mode = 'lobby' | 'interview' | 'teacher';

export default function Home() {
  const [documents, setDocuments] = useState<DocText[]>([]);
  const [interviewer, setInterviewer] = useState<Interviewer>('hiring-manager');
  const [mode, setMode] = useState<Mode>('lobby');

  return (
    <main className="flex min-h-screen flex-col justify-center px-4 py-8 sm:py-12">
      {mode === 'interview' ? (
        <Call documents={documents} interviewer={interviewer} onEnd={() => setMode('lobby')} />
      ) : mode === 'teacher' ? (
        <CoBrowseTeacher onBack={() => setMode('lobby')} />
      ) : (
        <Lobby
          documents={documents}
          setDocuments={setDocuments}
          interviewer={interviewer}
          setInterviewer={setInterviewer}
          onStart={() => setMode('interview')}
          onStartTeacher={() => setMode('teacher')}
        />
      )}
    </main>
  );
}
