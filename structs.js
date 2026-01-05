let sst_side = 40;

//sst class
class Sst {
    constructor(number) {
        this.x = 0;
        this.y = 0;
        this.label = "0";
        this.side = sst_side
        this.number = number;
        this.tier = null;
        this.dest_x = undefined;
        this.dest_y = undefined;
        this.animating = false;
        
        this.hits = 0;
        this.writes = 0;

        this.anim_xvector = 0;
        this.anim_yvector = 0;
    }

}

//tier class
class Tier {
    constructor(index) {
        this.index = index;
        this.files = new Map();
        this.cache = new Map();
    }
}

class Run {
    constructor() {
        this.command_groups = [];
        this.frame = 0;
        this.frame_num = 20;
    }


    mainloop() {
        if (this.frame == this.frame_num) {
            if (this.command_groups.length > 0) {
                // this.commands[0]();

                //commmands are pairs where the first element is the function and the second is the arguments
                let command = this.command_groups[0];
                command[0].apply(this, command[1]);

                //remove the first command
                this.command_groups.shift();
            }
            this.frame = 0;
        } else {
            this.frame += 1;
        }
    }
}


module.exports = {
    Sst,
    Tier,
    Run
};
