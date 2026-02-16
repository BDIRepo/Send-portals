// ==UserScript==
// @id             iitc-plugin-Send-portals
// @name           IITC plugin: Send portals
// @category       Info
// @version        0.2.1
// @namespace      X
// @updateURL      https://github.com/BDIRepo/Send-portals/raw/master/send-portals.meta.js
// @downloadURL    https://github.com/BDIRepo/Send-portals/raw/master/send-portals.user.js
// @description    Send portals to external database.
// @include        https://*.ingress.com/intel*
// @include        http://*.ingress.com/intel*
// @match          https://*.ingress.com/intel*
// @match          http://*.ingress.com/intel*
// @include        https://*.ingress.com/mission/*
// @include        http://*.ingress.com/mission/*
// @match          https://*.ingress.com/mission/*
// @match          http://*.ingress.com/mission/*
// @grant          none
// ==/UserScript==


function wrapper(plugin_info) {
// ensure plugin framework is there, even if iitc is not yet loaded
    if(typeof window.plugin !== 'function') window.plugin = function() {};

//PLUGIN AUTHORS: writing a plugin outside of the IITC build environment? if so, delete these lines!!
//(leaving them in place might break the 'About IITC' page or break update checks)
    plugin_info.buildName = 'iitc';
    plugin_info.dateTimeVersion = '20210328.21732';
    plugin_info.pluginId = 'send-portals';
//END PLUGIN AUTHORS NOTE



// PLUGIN START ///////////////w/////////////////////////////////////////

// use own namespace for plugin
    window.plugin.sendportal = {};

    window.plugin.sendportal.getPortals = function() {

        var displayBounds = map.getBounds();
        let jportals = [];
        window.plugin.sendportal.listPortals = [];
        $.each(window.portals, function(i, portal) {
            // eliminate offscreen portals (selected, and in padding)
            if(!displayBounds.contains(portal.getLatLng())) return true;
            if (!portal.options.data.title) return true;

            tempjportals = {
                guid: portal.options.guid,
                lat: portal.options.data.latE6,
                lng: portal.options.data.lngE6,
                title: portal.options.data.title,
                image: portal.options.data.image,
                visited: portal.options.ent[2][18],
                mission: portal.options.data.mission,
                mission50plus: portal.options.data.mission50plus
            }
            jportals.push(tempjportals);
        });
        zz = {
            bounds: displayBounds,
            zoom: map.getZoom(),
            nick:  window.PLAYER.nickname,
            ap:  window.PLAYER.ap,
            team:  window.PLAYER.team,
            portals: jportals
        }

        var test = JSON.stringify(zz)
        console.log(test)
        if (jportals.length > 0) {
            yourUrl = 'https://swagbox.pl/api/portals';
            var xhr = new XMLHttpRequest();
            xhr.open("POST", yourUrl, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(zz));
        } else { console.log("brak portali")}



        return true;
    }

    window.plugin.sendportal.panel = function() {
        //var content = '<div id="main">'
        window.plugin.sendportal.getPortals();
        var nick = window.PLAYER.nickname
        var title = 'Send Portals'

        dialog({
            html: '<div id="main">' +
                '<p id="hello">Cześć '+nick+', Zaczynamy?</p>' +
                '<button id="start">Start</button>' +
                '</div>',
            title: title,
            width: 'auto'
        });

    }

    var setup = function () {
        console.log('Send Portals Setup Start')
        $('#toolbox').append('<a onclick="window.plugin.sendportal.panel()" title="Send portals to external database" accesskey="h">Send Portals</a>');
    }

// PLUGIN END //////////////////////////////////////////////////////////


    setup.info = plugin_info; //add the script info data to the function as a property
    if(!window.bootPlugins) window.bootPlugins = [];
    window.bootPlugins.push(setup);
// if IITC has already booted, immediately run the 'setup' function
    if(window.iitcLoaded && typeof setup === 'function') setup();
} // wrapper end
// inject code into site context
var script = document.createElement('script');
var info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) info.script = { version: GM_info.script.version, name: GM_info.script.name, description: GM_info.script.description };
script.appendChild(document.createTextNode('('+ wrapper +')('+JSON.stringify(info)+');'));
(document.body || document.head || document.documentElement).appendChild(script);