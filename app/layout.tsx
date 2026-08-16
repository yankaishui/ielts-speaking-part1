import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Part 1 练习 · IELTS Speaking",
  description: "使用 Emma 考官语音练习 IELTS Speaking Part 1，支持大陆与加拿大题库、模拟考试、专项练习与录音。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
