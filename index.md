帮我写一个电脑连接wifi然后跑流量的工具。
## 功能描述
获取接口需要测速的wifi设备列表。然后扫描电脑附近的所有wifi网络，匹配设备列表中的wifi名称。
如果匹配到，就连接wifi。连接成功后，就开始跑流量。大概跑100~200MB左右，不要每个WIFI都跑一样的量。在这区间随机。
需要有个页面展示进度，左边展示所有设备列表，右边展示所有扫描到的wifi列表。
上面可以配置一个备用wifi名称和密码。有时候切换wifi，然后测试完上报数据的时候没网的话，可以连接到备用wifi进行上报。
页面同时有个开始跑量(执行全流程)，扫描wifi(单扫描更新wifi列表即可)。同时可以配置定时器，有配置的话就定期自动开始跑量。
## 注意点
扫描到wifi列表的时候要优化缓存下，不需要每次都扫描。可以获取所有设备，用每个设备去比对有没有wifi，有的话连接，没的话重试几次，还没有说明wifi没开启，就默认失败了。
## 接口
- 获取待测速WIFI设备列表。
url：”/bms-sim/check/device/findSpeedDevice“，返回数据格式[
{
"sn": "56132044000038",
"wifiName": "JH-000020",
"wifiPassword": "12345678"
}
]
- 上报测速接口。
url："/bms-sim/check/device/speed/record/uploadSpeedRecord"，formData参数{
sn，wifiName，wifiPassword，useFlow，status：1成功0失败，speedStartTime，speedEndTime}