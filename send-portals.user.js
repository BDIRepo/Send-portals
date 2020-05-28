// ==UserScript==
// @id             iitc-plugin-Send-portals
// @name           IITC plugin: Send portals
// @category       Info
// @version        0.1.2
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
    plugin_info.dateTimeVersion = '20170108.21732';
    plugin_info.pluginId = 'portal-counts';
//END PLUGIN AUTHORS NOTE



// PLUGIN START ////////////////////////////////////////////////////////

// use own namespace for plugin
    window.plugin.sendportal = {};

    window.plugin.sendportal.panel = function() {
        //var content = '<div id="main">'
        var counts = window.PLAYER.nickname
        var title = 'Send Portals'

            dialog({
            html: '<div id="main">' + counts + '</div>',
            title: title,
            width: 'auto'
        });

        window.plugin.sendportal.panel.getBounds = function(){
            map.getBounds()
        }



        var setup =  function() {
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
}