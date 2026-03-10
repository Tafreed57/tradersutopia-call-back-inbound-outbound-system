self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Traders Utopia", body: event.data ? event.data.text() : "New notification" };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Traders Utopia", {
      body: data.body || "An agent took a call",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag || "tu-call",
      renotify: true,
      data: { url: data.url || "/dashboard" },
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || "/dashboard";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes("/dashboard") && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
