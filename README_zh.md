# 从低维的文章中重建高维的思想

**阅读其他语言版本: [English](README.md).**

# 新闻！
全新的v2.0.0版本来啦！

后端使用QDrant向量数据库，支持使用LLM进行自然语言的文献检索！

# 主要功能

在文章任意位置打上高亮标记，或者创建子标题，然后所有你的比笔记和标题都会自动转变成思维导图。

## 思维导图

https://github.com/user-attachments/assets/c290f172-9b79-427b-b9ed-adcd5792374e

## 添加高亮笔记

https://github.com/user-attachments/assets/23918295-c817-477d-b9df-214a9a58bb43

## 添加子标题

https://github.com/user-attachments/assets/62e37758-771f-42e5-b457-ede1bbe8c4b4

## 提出阅读问题

https://github.com/user-attachments/assets/87e89e56-2a9c-43c6-97ff-c4804adc21be

## 关联笔记和问题

https://github.com/user-attachments/assets/f4169351-3bd6-4cda-96b4-41fd68b92fe8

## 询问AI

https://github.com/user-attachments/assets/57f7298e-1f5a-4c6f-b3ef-0edd81cf3bba

## 上传PDF

https://github.com/user-attachments/assets/e98cd7e1-49dd-458c-854f-d9679c903ae4

# AI API 设置

点击右上角设置按钮，可以配置你的API KEY以及API URL。

# 翻译

默认使用CNKI翻译。如果配置了AI API可切换为AI翻译。

# 本地多字段向量索引（title/author/summary/method）

已接入本地向量索引构建，索引字段为：

- `title`
- `author`
- `summary`
- `method`

运行前请确保：

1. 本地已启动 Qdrant（默认 `http://127.0.0.1:6333`）
2. 本机可执行 `python3`
3. Python 环境已安装 `sentence-transformers`

主进程会在启动时初始化集合并基于 `papers.json` 做首轮同步；后续 `saveSnapshot/savePapers` 会自动增量同步。

## 打包内置 Qdrant（mac 自动拉起）

可将 Qdrant 二进制放入：

- `resources/qdrant/qdrant-macos`
- `resources/qdrant/qdrant-win.exe`
- `resources/qdrant/qdrant-linux`

打包后会被复制到 `Resources/qdrant/...`，应用首次打开时会自动尝试拉起本地 Qdrant。
