import { CurrentGameScreen } from "@/components/CurrentGameScreen";

export default function HomePage() {
  return (
    <main className="new-game-page">
      <header className="new-game-hero">
        <p className="new-game-kicker">AI GENERATED ROLE-PLAYING GAME</p>
        <h1>从一句故事开端，生成你的世界</h1>
        <p>
          类型约束世界观与画风；你的角色、背景和开端决定这一局从哪里发生。
          AI 负责生成候选，规则系统负责判断真正发生的事。
        </p>
      </header>
      <CurrentGameScreen />
    </main>
  );
}
