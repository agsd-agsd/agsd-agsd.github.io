var posts=["2026/01/29/BrokerHub学习Day1/","2026/01/27/hello-world/","2026/01/27/test/","2026/02/02/Hexo-anzhiyu-Theme搭建博客工具箱合集/"];function toRandomPost(){
    pjax.loadUrl('/'+posts[Math.floor(Math.random() * posts.length)]);
  };