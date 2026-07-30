// 共享的角色矢量头像：HUD 玩家卡与角色面板复用，尺寸与配色由外层 CSS 控制。
export function CharacterAvatarIcon() {
  return (
    <svg viewBox="0 0 64 64" focusable="false" aria-hidden="true">
      <circle cx="32" cy="32" r="30" />
      <circle cx="32" cy="25" r="11" />
      <path d="M12 56c4-13 12-19 20-19s16 6 20 19" />
    </svg>
  );
}
