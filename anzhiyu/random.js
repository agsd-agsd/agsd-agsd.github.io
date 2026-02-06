var posts=["2026/02/02/Adobe-Express帮助你创建背景透明图片/","2026/02/02/在flaticon帮你的网站找到一个好看的矢量图标/","2026/01/29/BrokerHub/"];function toRandomPost(){
    pjax.loadUrl('/'+posts[Math.floor(Math.random() * posts.length)]);
  };