# IELTS Speaking Part 1

**[在线练习](https://part1.yankaishui.com/practice)** · [IELTS Practice 系列](https://github.com/yankaishui)

我需要一个“考官”，从当季题库里按主题随机提问。同一个主题问完，再换下一个，不能上一题还在聊家乡，下一题突然跳到摄影。

之前试过把整个题库喂给 GPT，再反复强调抽题规则，但效果一直不理想：要么问到题库外，要么在不同主题间跳来跳去。这个工具把题库和抽题顺序固定在程序里，随机选主题，再围绕这个主题提问，不用每次重新跟 AI 解释规则。

考官语音也挑了很久。本来想让 Benedict Cumberbatch 或 Emma Watson 陪大家练口语，技术上可以做，但没有授权，不能放到网上。最后选了一个听起来比较自然的声音，希望练久了也不至于太折磨耳朵。

遇到不熟的问题可以标记，之后专门复习。练完还能把考官提问和自己的回答一起导出，回听的时候不用猜自己当时在回答哪道题。

## 记录和录音

练习记录和答案内容保存在当前浏览器里，录音可以自行导出，不会上传到网站服务器。正式站会统计页面访问和开始、完成练习等匿名使用次数，不收集答案或录音。清理浏览器数据或更换浏览器后，本地记录不会自动跟随。

## 本地运行

使用 Node.js 22.13 或更高版本和 pnpm：

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

打开终端显示的地址，并访问 /practice。

构建：

```sh
pnpm run build
```

## 其他练习

[Part 1](https://part1.yankaishui.com/practice) · [Part 2 & 3](https://part2.yankaishui.com/) · [Writing Task 2](https://writing.yankaishui.com/)
