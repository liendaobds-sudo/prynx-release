(function (payload) {
    // PONTLAYER (2026-09-09): chỉ sửa tài liệu mới do chính lượt bàn giao mở.
    var expected = new File(payload.appPath).fsName.toLowerCase();
    var actual = new File(app.path.fsName + "/Support Files/Contents/Windows/Illustrator.exe").fsName;
    if (actual.toLowerCase() !== expected) {
        throw new Error("Illustrator dang chay khong khop ung dung da duyet.");
    }
    var document = null;
    var oldInteraction = app.userInteractionLevel;
    try {
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
        document = app.open(new File(payload.path));
        var matches = [];
        var paths = document.pathItems;
        function spotName(color) {
            return color && color.typename === "SpotColor" ? color.spot.name : "";
        }
        function restoreColor(spec) {
            var color;
            if (spec.space === "DeviceCMYK") {
                color = new CMYKColor();
                color.cyan = spec.values[0] * 100;
                color.magenta = spec.values[1] * 100;
                color.yellow = spec.values[2] * 100;
                color.black = spec.values[3] * 100;
            } else if (spec.space === "DeviceRGB") {
                color = new RGBColor();
                color.red = spec.values[0] * 255;
                color.green = spec.values[1] * 255;
                color.blue = spec.values[2] * 255;
            } else {
                color = new GrayColor();
                color.gray = (1 - spec.values[0]) * 100;
            }
            return color;
        }
        // Kiểm đủ mọi dấu định danh trước khi tạo layer hoặc di chuyển bất kỳ nét nào.
        for (var i = 0; i < payload.marks.length; i++) {
            var mark = payload.marks[i];
            var found = null;
            for (var j = 0; j < paths.length; j++) {
                var path = paths[j];
                var strokeMatch = mark.stroke && path.stroked &&
                    spotName(path.strokeColor) === mark.token + "S";
                var fillMatch = mark.fill && path.filled &&
                    spotName(path.fillColor) === mark.token + "F";
                if (!strokeMatch && !fillMatch) continue;
                if (found || (mark.stroke && !strokeMatch) || (mark.fill && !fillMatch) ||
                    path.parent.typename === "CompoundPathItem") {
                    throw new Error("Khong the nhan dien duy nhat net boong.");
                }
                found = path;
            }
            if (!found) throw new Error("Illustrator khong giu dau nhan dien boong.");
            matches.push(found);
        }
        var layers = [];
        var groups = [];
        for (var n = 0; n < payload.infoNames.length; n++) {
            var info = document.layers.add();
            info.name = payload.infoNames[n];
        }
        for (var k = 0; k < payload.marks.length; k++) {
            var item = payload.marks[k];
            var layer = layers[item.layerKey];
            if (!layer) {
                layer = document.layers.add();
                layer.name = item.layerName;
                layers[item.layerKey] = layer;
            }
            var group = groups[item.groupKey];
            if (!group) {
                group = layer.groupItems.add();
                group.name = item.groupName;
                groups[item.groupKey] = group;
            }
            var target = matches[k];
            if (item.stroke) target.strokeColor = restoreColor(item.stroke);
            if (item.fill) target.fillColor = restoreColor(item.fill);
            target.name = item.itemName;
            target.move(group, ElementPlacement.PLACEATEND);
        }
        // Xóa swatch định danh tạm sau khi mọi nét đã trở về màu gốc.
        for (var s = document.spots.length - 1; s >= 0; s--) {
            if (document.spots[s].name.indexOf(payload.tokenPrefix) === 0) {
                document.spots[s].remove();
            }
        }
        app.redraw();
        return "PRYNX_OK:" + matches.length;
    } catch (error) {
        if (document) document.close(SaveOptions.DONOTSAVECHANGES);
        throw error;
    } finally {
        app.userInteractionLevel = oldInteraction;
    }
})
