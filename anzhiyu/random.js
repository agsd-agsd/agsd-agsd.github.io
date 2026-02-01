var posts=["2026/01/27/test/","2026/01/29/BrokerHub学习Day1/","2026/01/27/hello-world/"];function toRandomPost(){
    pjax.loadUrl('/'+posts[Math.floor(Math.random() * posts.length)]);
  };