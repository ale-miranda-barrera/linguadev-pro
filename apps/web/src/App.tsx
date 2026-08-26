import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Shell } from './components/Shell.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt.js';
import { OfflineBanner } from './components/OfflineBanner.js';
import { Dashboard } from './features/dashboard/Dashboard.js';
import { VocabReview } from './features/vocab/VocabReview.js';
import { Lesson } from './features/lesson/Lesson.js';
import { Speaking } from './features/speaking/Speaking.js';
import { Listening } from './features/listening/Listening.js';
import { Writing } from './features/writing/Writing.js';
import { VoiceCall } from './features/voice-call/VoiceCall.js';
import { CreatePack } from './features/create/CreatePack.js';
import { Tutor } from './features/tutor/Tutor.js';
import { Chat } from './features/chat/Chat.js';
import { Placement } from './features/dashboard/Placement.js';
import { Settings } from './features/dashboard/Settings.js';
import { LevelPath } from './features/path/LevelPath.js';
import { AwsHome } from './features/aws/AwsHome.js';
import { AwsCert } from './features/aws/AwsCert.js';
import { AwsSimRunner } from './features/aws/AwsSimRunner.js';
import { ProgrammingHome } from './features/programming/ProgrammingHome.js';
import { TechTrackDetail } from './features/programming/TechTrackDetail.js';
import { TechSimRunner } from './features/programming/TechSimRunner.js';
import { TechMixMode } from './features/programming/TechMixMode.js';
import { Progress } from './features/progress/Progress.js';
import { useProfileStore } from './stores/profile.js';
import { usePacksStore } from './stores/packs.js';

export default function App() {
  const loadProfile = useProfileStore((s) => s.load);
  const loadPacks = usePacksStore((s) => s.loadInstalled);
  useEffect(() => {
    // Hidratación única al arrancar. Cada feature igual puede llamar load() como safety net.
    void loadProfile();
    void loadPacks();
  }, [loadProfile, loadPacks]);

  return (
    <ErrorBoundary>
      <OfflineBanner />
      <PwaUpdatePrompt />
      <Shell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/placement" element={<Placement />} />
          <Route path="/vocab" element={<VocabReview />} />
          <Route path="/lesson/:packId?" element={<Lesson />} />
          <Route path="/listening" element={<Listening />} />
          <Route path="/speaking" element={<Speaking />} />
          <Route path="/writing" element={<Writing />} />
          <Route path="/voice-call" element={<VoiceCall />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/create" element={<CreatePack />} />
          <Route path="/tutor" element={<Tutor />} />
          <Route path="/path" element={<LevelPath />} />
          <Route path="/aws" element={<AwsHome />} />
          <Route path="/aws/:certId" element={<AwsCert />} />
          <Route path="/aws/:certId/sim/:simId" element={<AwsSimRunner />} />
          <Route path="/programming" element={<ProgrammingHome />} />
          <Route path="/programming/mix" element={<TechMixMode />} />
          <Route path="/programming/:trackId" element={<TechTrackDetail />} />
          <Route path="/programming/:trackId/sim/:simId" element={<TechSimRunner />} />
          <Route path="/progress" element={<Progress />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </ErrorBoundary>
  );
}
