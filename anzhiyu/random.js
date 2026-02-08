var posts=["2026/01/29/BrokerHub/","2026/02/08/anzhiyu主题初始界面放大/","2026/02/08/为twikoo评论系统设置二级域名/","2026/02/07/用Google-Fonts为Hexo博客替换字体/","2026/02/02/Adobe-Express帮助你创建背景透明图片/","2026/02/02/在flaticon帮你的网站找到一个好看的矢量图标/"];function toRandomPost(){
    pjax.loadUrl('/'+posts[Math.floor(Math.random() * posts.length)]);
  };